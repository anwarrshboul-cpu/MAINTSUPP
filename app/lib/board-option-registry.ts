import type { BoardColumnOption } from "./types";

/**
 * Browser-side cache of the option list the board has already fetched.
 *
 * The mobile job card needs a label's colour deep inside a component tree that
 * does not receive the board's props. Before Stage 2 it imported a hardcoded
 * array, which meant an admin renaming or recolouring a status saw no change on
 * mobile. This registry lets the board publish what it loaded from the database
 * so every screen renders the same configured values.
 *
 * This is per-tab render state for data the user is already looking at, not a
 * data source: it is never read on the server and never written from a seed.
 * When it is empty, callers fall back to a neutral style rather than inventing
 * a label.
 */
let published: BoardColumnOption[] = [];

export function publishBoardOptions(options: BoardColumnOption[]) {
  published = options;
}

export function publishedBoardOptions(): BoardColumnOption[] {
  return published;
}
