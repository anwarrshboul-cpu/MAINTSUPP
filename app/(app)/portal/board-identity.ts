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

export function boardIdentity(boardId: string): BoardIdentity {
  return IDENTITIES[boardId] ?? IDENTITIES.maintenance;
}
