/**
 * The default structure a NEW platform section's register is created with.
 *
 * W02-06. The owner's decision: adding a section must not be a second door onto
 * an existing screen — it must produce its own independent, configurable
 * register on the canonical board engine. This file is the ONE default that
 * every such register starts from.
 *
 * WHY IT IS NOT `monday-board-spec.ts`.
 *
 * That file holds the Maintenance board's 26 columns and the Store
 * Documentation board's 12, and both are domain-specific: Tier Level, Engineer
 * Required, Contractor, Picture of completed works, PAT expiry. Seeding any of
 * them into a section called "CCTV" would be inventing a data model for work
 * nobody described. What is generic about those boards is their SHAPE — a
 * titled row, a status, an owner, a date, some notes, some files, filed into
 * groups — and that shape is what this reproduces.
 *
 * WHY IT IS NOT A COPY OF A LIVE BOARD.
 *
 * A live board is mutable: an admin who deletes a column on Maintenance would
 * silently change what every future section is born with, and a template that
 * drifts is worse than no template. These literals are deterministic, so two
 * sections created a year apart start identically.
 *
 * THE TWO VOCABULARIES, AND WHY THIS FILE USES THE SECOND.
 *
 * The seeded boards' columns carry legacy type names — `status`, `dropdown`,
 * `files`, `people` — and are `system`, meaning their values come from fields on
 * `maintenance_requests` rather than from cells. `systemCell` in `live-board.tsx`
 * has a case for each of those 26 keys and for nothing else, so a generic board
 * cannot use them: a column named `owner` marked system would render blank
 * forever with no cell to read.
 *
 * The types below are the ones `app/lib/column-types.ts` defines and
 * `POST /api/board/columns` accepts, and every column except the row's own name
 * is `system: false`, i.e. cell-backed — exactly what an admin gets today when
 * they add a column by hand. That is the path the product supports for
 * configurable columns, so it is the path a generated register is built on.
 */

export type GenericChoice = { id: string; label: string; color: string };

/**
 * The status vocabulary a generated register starts with.
 *
 * The same four `defaultSettings("status")` in the board route hands any column
 * an admin adds by hand, written here rather than imported because that
 * function is private to the route and this file is read by the registry. They
 * are monday's own generic defaults: wrong for the Maintenance board — a note
 * in `db/init.ts` records them appearing there by accident and calls them "the
 * API's own scaffolding" — and right for a register nobody has configured yet,
 * because they say nothing about the work and every one is meant to be renamed.
 */
export const GENERIC_STATUS_CHOICES: GenericChoice[] = [
  { id: "not-started", label: "Not started", color: "#b6b6b6" },
  { id: "working-on-it", label: "Working on it", color: "#fdab3d" },
  { id: "done", label: "Done", color: "#00c875" },
  { id: "stuck", label: "Stuck", color: "#e2445c" },
];

export type GenericColumn = {
  key: string;
  title: string;
  /**
   * A `BoardColumnType` — the vocabulary the GRID renders, which is not the one
   * `app/lib/column-types.ts` defines.
   *
   * The product has two column vocabularies and they do not map. `POST
   * /api/board/columns` validates against `column-types.ts` (`single_select`,
   * `person`, `file`), while `columnPayload` in the board route serialises
   * anything outside `BOARD_COLUMN_TYPES` as plain `text`. A register seeded
   * with `single_select` therefore came back to the browser as a text box —
   * which is what the first cut of this template did, and it renders but is not
   * the column the owner was promised. These are the board's own names.
   */
  type: string;
  width: number;
  /** True only for the row's own title, which is a field and not a cell. */
  system?: boolean;
  required?: boolean;
  /** Written into the column's stored `settings`, as the grid expects to read it. */
  settings?: Record<string, unknown>;
};

/**
 * Six columns: what a register needs to be usable on the first load and
 * nothing that presumes what it is for.
 *
 * `name` is `system` because on every board in this product the first column is
 * the row's own title on `maintenance_requests` — Store Documentation is
 * cell-backed for all twelve of its columns and still takes Name off the
 * request. Marking it cell-backed would give every row two names, one always
 * empty.
 *
 * The status column is keyed `state`, NOT `status`, and that is deliberate:
 * `optionColumns` in the board route treats the key `status` as one of the five
 * maintenance columns whose choices come from `maintenance_board_options`
 * rather than from the column's own settings. A generated register has no rows
 * in that table, so borrowing the key would borrow an empty vocabulary.
 */
export const GENERIC_BOARD_COLUMNS: GenericColumn[] = [
  { key: "name", title: "Item", type: "text", width: 300, system: true, required: true },
  {
    key: "state",
    title: "Status",
    type: "status",
    width: 170,
    settings: { choices: GENERIC_STATUS_CHOICES },
  },
  { key: "owner", title: "Owner", type: "people", width: 170 },
  { key: "date", title: "Date", type: "date", width: 145 },
  { key: "notes", title: "Notes", type: "long_text", width: 260 },
  { key: "files", title: "Files", type: "files", width: 120 },
];

export type GenericGroup = { key: string; name: string; colour: string };

/**
 * Three groups, because a board with one group cannot demonstrate what a group
 * is for and a board with none has nowhere to put a row. The colours are from
 * `GROUP_COLORS`, which the group writer validates against and silently
 * replaces anything else with.
 */
export const GENERIC_BOARD_GROUPS: GenericGroup[] = [
  { key: "todo", name: "To do", colour: "#579bfc" },
  { key: "doing", name: "In progress", colour: "#fdab3d" },
  { key: "done", name: "Done", colour: "#00c875" },
];

/** What a column with no settings of its own stores. */
export const GENERIC_COLUMN_SETTINGS = JSON.stringify({ wrap: false });


/* ── The Jobs template ────────────────────────────────────────────────────── */

/**
 * WHICH OF THE JOB BOARD'S GROUPS BELONG TO THE TEMPLATE — and which are this
 * estate's own filing.
 *
 * `maintenanceGroups` in `monday-board-spec.ts` holds 38. Twenty-eight of them
 * are `done-<store>` — Wood Green, Aldgate, Bluewater, Trafford Centre — and
 * three more are dated month archives (`completed-2026-06/07/08`). Those are
 * not the Jobs product; they are where THIS workspace has filed THIS estate's
 * finished work, and a section created for CCTV arriving with a "Bluewater
 * completed" lane would be the "clone the live board" mistake the owner ruled
 * out in the same breath as asking for parity.
 *
 * What is left is the operational shape a job actually moves through, and that
 * is the template: incoming, booked, blocked, on hold, access, international.
 * `STAGE_BY_GROUP_KEY` in `db/init.ts` maps three of these onto request stages,
 * so a job filed by the workflow lands in the right lane on an instance exactly
 * as it does on the canonical board.
 *
 * Ordered as the spec orders them, so the lanes read the same way round.
 */
export const JOBS_TEMPLATE_GROUP_KEYS: readonly string[] = [
  "topics",
  "jobs-booked",
  "needs-attention",
  "on-hold",
  "access-requests",
  "international",
];

/**
 * What a section's register is BUILT FROM.
 *
 * One registry rather than a branch per template, because the owner's
 * requirement is explicitly that an instance and its source run the same code:
 * a template names the spec arrays the canonical board is itself seeded from,
 * and the provisioner reads them. Adding a template is a row here, not a fifth
 * implementation.
 *
 * `columns: "maintenance"` means "seed this board with the same columns
 * `seedBoardStructure` gives the job board" — the 26 request-backed ones, whose
 * values live on `maintenance_requests` and therefore work on any board a row
 * is placed on. That is what makes a Jobs instance a Jobs board rather than a
 * lookalike.
 */
export type TemplateStructure = {
  /**
   * Which column spec to seed. `generic` is the six below.
   *
   * `none` means THIS TEMPLATE'S SURFACE IS NOT A BOARD. Sites and Contractors
   * draw their own screens off their own tables, so seeding six columns onto
   * their board would be litter nothing ever renders. The board row is still
   * created, and that is the point of the model: the board KEY is the
   * instance's identity, and the scope column on `sites` / `contractors` points
   * at it. One instance model for all four templates, whether or not the
   * instance happens to be drawn as a grid.
   */
  columns: "maintenance" | "store-documentation" | "generic" | "none";
  /** Group keys from the same spec, the generic three, or none at all. */
  groups: readonly string[] | "generic" | "none";
  /** The board `kind`, which several surfaces switch on. */
  kind: string;
  /** The noun a row is called, used by `newItemTitle` and the row counts. */
  itemNoun: string;
};

export const TEMPLATE_STRUCTURES: Record<string, TemplateStructure> = {
  jobs: {
    columns: "maintenance",
    groups: JOBS_TEMPLATE_GROUP_KEYS,
    kind: "maintenance",
    itemNoun: "Job",
  },
  "store-documentation": {
    columns: "store-documentation",
    groups: "generic",
    kind: "store-documentation",
    itemNoun: "Store",
  },
  /*
   * The two register templates, whose surfaces are screens rather than grids.
   *
   * They still get a board row, because that row is what the instance IS: the
   * key it carries is what `sites.scope_board_id` / the contractor register's
   * scope points at, what the purge tests for ownership, and what
   * `workspace_sections.surface_ref` already stores. Modelling them any other
   * way would be the fourth disconnected implementation the owner ruled out.
   */
  contractors: { columns: "none", groups: "none", kind: "contractors", itemNoun: "Contractor" },
  sites: { columns: "none", groups: "none", kind: "sites", itemNoun: "Site" },
  /* The fallback, and what every section created before templates existed has.
     Kept so an unknown or absent template still produces a usable register
     rather than an empty canvas. */
  generic: { columns: "generic", groups: "generic", kind: "maintenance", itemNoun: "Item" },
};

export function templateStructure(template: string | null | undefined): TemplateStructure {
  return TEMPLATE_STRUCTURES[template ?? ""] ?? TEMPLATE_STRUCTURES.generic;
}
