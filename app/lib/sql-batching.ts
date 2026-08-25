/**
 * Chunking for `IN (…)` queries.
 *
 * SQLite compiles every element of an `IN` list to its own bound parameter, and
 * D1 rejects a statement past its variable limit with
 * `too many SQL variables`. That limit is well under the number of rows a real
 * board holds: reading the cells for a page of items built one `IN` list per
 * page, so `/api/board/items?limit=500` answered 503 the moment the board had
 * 744 items in it — which is to say, the moment the monday import ran.
 *
 * 90 keeps a comfortable margin under the 100-variable floor for the handful of
 * other bound values in the same statement (organisation, board, flags).
 */
export const SQL_VARIABLE_CHUNK = 90;

/**
 * Chunking for multi-row `INSERT … VALUES` statements.
 *
 * An `IN` list binds ONE variable per element; a bulk insert binds one per
 * COLUMN per row, so the safe row count depends on the table's width. The
 * recycle bin writes 12 columns a row, which put a 20-row bulk delete at 240
 * variables — far past the same limit `chunkIds` exists for — and every
 * "Delete selected" of more than eight items answered 503. Divide the budget
 * by the row width and the widest table still fits.
 */
export function chunkRows<T>(rows: readonly T[], columnsPerRow: number): T[][] {
  const size = Math.max(1, Math.floor(SQL_VARIABLE_CHUNK / Math.max(1, columnsPerRow)));
  return chunkIds(rows, size);
}

/** Splits a list into chunks small enough to bind in one statement. */
export function chunkIds<T>(ids: readonly T[], size = SQL_VARIABLE_CHUNK): T[][] {
  if (ids.length <= size) return ids.length ? [[...ids]] : [];
  const chunks: T[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

/**
 * Runs `query` once per chunk and concatenates the rows.
 *
 * Sequential rather than concurrent: D1 serialises statements on one connection
 * anyway, and firing nine at once against a large board only makes the failure
 * mode harder to read.
 */
export async function selectInChunks<Row, Id>(
  ids: readonly Id[],
  query: (chunk: Id[]) => Promise<Row[]>,
  size = SQL_VARIABLE_CHUNK,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const chunk of chunkIds(ids, size)) {
    rows.push(...(await query(chunk)));
  }
  return rows;
}
