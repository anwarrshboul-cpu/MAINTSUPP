/**
 * How each board describes itself.
 *
 * The grid is shared, so its headings have to come from somewhere other than
 * hardcoded maintenance copy — a document board headed "Maintenance operations
 * board" is just wrong. Kept out of `live-board.tsx` because that file has a
 * 6,000-line ceiling a test enforces, and copy is exactly the kind of thing
 * that should not be spending lines there.
 *
 * This is presentation only. Board rows, columns and groups all come from the
 * database; nothing here is configuration.
 */

export type BoardIdentity = {
  /** Small chip above the heading. */
  eyebrow: string;
  heading: string;
  blurb: string;
  /** Short name used in the mobile board bar. */
  shortName: string;
  /** Noun for the row count, already pluralised. */
  itemNoun: string;
};

const IDENTITIES: Record<string, BoardIdentity> = {
  maintenance: {
    eyebrow: "Live maintenance workspace",
    heading: "Maintenance operations board",
    blurb:
      "Tickets flow into a live sheet where every group, row and workflow cell can be managed in place.",
    shortName: "Maintenance",
    itemNoun: "live items",
  },
  "store-documentation": {
    eyebrow: "Compliance documents",
    heading: "Store Documentation UK",
    blurb:
      "Every store's certificates and drawings in one sheet, with each document's expiry tracked beside it.",
    shortName: "Store Documentation",
    itemNoun: "stores",
  },
};

/**
 * What a board this file has never heard of calls itself — W02-06.
 *
 * Registers generated for workspace sections are created at runtime, so they
 * can never be in the map above. Falling through to `IDENTITIES.maintenance`
 * gave a CCTV register the eyebrow "Live maintenance workspace" and the noun
 * "live items" — the screen describing itself as the job board while showing
 * six generic columns and none of its rows.
 *
 * Neutral rather than invented: it says the section is a workspace section and
 * counts plain items, and `sectionIdentity` replaces the heading and the blurb
 * with the workspace's own words a moment later.
 */
const GENERIC_IDENTITY: BoardIdentity = {
  eyebrow: "Workspace section",
  heading: "Register",
  blurb: "A register this workspace added, with its own columns, filters and views.",
  shortName: "Register",
  itemNoun: "items",
};

export function boardIdentity(boardId: string): BoardIdentity {
  return IDENTITIES[boardId] ?? GENERIC_IDENTITY;
}

/**
 * The same identity, under the name the workspace gave this section — W02-07.
 *
 * A section called "CCTV" that draws the job board is titled CCTV. The topbar
 * already did that (`portal-app.tsx` overrides `meta.title`), but the topbar is
 * the one place the name was applied, and it is not rendered at all below
 * 768px: the page's own `<h1>` came from this map, keyed on the BOARD, so the
 * heading read "Maintenance operations board" and the mobile bar — the only
 * name on a phone — read "Maintenance". A section was never called by its own
 * name on the page it opened, and on a phone was never called by it anywhere.
 *
 * Only the two NAMES are replaced. The eyebrow, the blurb and the item noun
 * still describe the screen, because they describe what the grid is and that
 * has not changed — a CCTV section drawing the job board still holds jobs, and
 * saying otherwise would be the invention this file's header rules out.
 *
 * `label` empty or absent gives the board's own identity back unchanged, so a
 * built-in section is untouched by this.
 */
export function sectionIdentity(
  boardId: string,
  label?: string | null,
  description?: string | null,
): BoardIdentity {
  const identity = boardIdentity(boardId);
  const name = label?.trim();
  const blurb = description?.trim();
  if (!name && !blurb) return identity;
  return {
    ...identity,
    ...(name ? { heading: name, shortName: name } : {}),
    /* The workspace's own words when it gave any, otherwise the screen's. A
       section with a name but no description still describes the grid
       correctly, which is why these two are independent rather than one
       override. */
    ...(blurb ? { blurb } : {}),
  };
}
