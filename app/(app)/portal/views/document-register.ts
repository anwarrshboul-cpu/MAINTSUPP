/**
 * The document register's model: what a document's status IS, and what the
 * filter bar filters.
 *
 * WHY THIS FILE EXISTS. The Documents register used to carry a `Status` column
 * fed by a constant. `loadDocuments` in portal-app.tsx mapped every row from
 * `/api/files` with `status: "Current"` written into the object literal, and
 * the table rendered that as though it were data — so all thirty-seven rows on
 * a local workspace read "Current", the distinct set of the column was exactly
 * `["Current"]`, and the "Require attention" tile, which counted
 * `status === "Expiring soon"`, was pinned to zero by construction. A column
 * that looks like data and is a literal is worse than a missing column: nobody
 * acts on a gap, and people do act on a green chip.
 *
 * So status is DERIVED here and stored nowhere. The verdict comes from
 * `app/lib/expiry-status.ts` — the same classifier the Compliance Tracker, the
 * renewal calendar, the board's expiry cells and the server-side digest all
 * use. One threshold, one classifier, one answer: if the tracker says a
 * certificate is due soon, this register cannot disagree with it, because
 * neither of them decides.
 *
 * It is a pure module — no hooks, no JSX, no DOM, no clock of its own. `today`
 * is always injected, so a whole register is classified against one instant
 * instead of drifting across the loop, and a test can pin the date. That is the
 * convention `expiry-status.ts` itself sets and the reason its verdicts are
 * testable at all.
 */

import {
  EXPIRY_DUE_SOON_DAYS,
  expiryStatus,
  type ExpiryState,
} from "../../../lib/expiry-status";
import type { FileRecord } from "../../../lib/types";

/* ── Status ───────────────────────────────────────────────────────────────── */

/**
 * The register's verdict on one document.
 *
 * `archived` first, then the four expiry states. Archived is not an expiry
 * state and must not be one: an archived certificate that is also out of date
 * is archived — it has been withdrawn from the register on purpose, and
 * reporting it as "Expired" would put a withdrawn document back into the
 * compliance count it was removed from.
 */
export type DocumentState = "archived" | ExpiryState;

export type DocumentStatus = {
  state: DocumentState;
  /** The word on the chip. Always rendered with the colour, never instead. */
  label: string;
  /** A full sentence for the drawer and the row title, never just a colour. */
  description: string;
  /** The `YYYY-MM-DD` behind the verdict, or null when none is recorded. */
  date: string | null;
  /** Whole days to expiry; negative once expired, null when unrecorded. */
  daysRemaining: number | null;
};

/**
 * What this document's status is, right now.
 *
 * The `not-recorded` wording is deliberately "No expiry set" rather than
 * `expiry-status.ts`'s own "Not recorded". The shared classifier is written for
 * compliance certificates, where a missing date is an open finding and should
 * read like one. This register also holds maintenance photographs, delivery
 * notes and invoices, and most of them have no expiry because they cannot have
 * one — labelling a photograph "Not recorded" states a fault that does not
 * exist. "No expiry set" is true of both, and it claims nothing: it does not
 * say the document is current, and it does not say it is a finding. The STATE
 * is the shared classifier's, unchanged, so the two screens still agree about
 * every row; only the word is register-appropriate.
 */
export function documentStatus(
  file: Pick<FileRecord, "archivedAt" | "expiryDate">,
  today: Date = new Date(),
): DocumentStatus {
  if (file.archivedAt) {
    return {
      state: "archived",
      label: "Archived",
      description: "archived, and out of the live register",
      date: null,
      daysRemaining: null,
    };
  }
  const expiry = expiryStatus(file.expiryDate, today);
  return {
    state: expiry.state,
    label: expiry.state === "not-recorded" ? "No expiry set" : expiry.label,
    description:
      expiry.state === "not-recorded"
        ? "no expiry date is set for this document"
        : expiry.description,
    date: expiry.date,
    daysRemaining: expiry.daysRemaining,
  };
}

/** The class suffix for a state, so CSS never keys on a lower-cased label. */
export function documentStateClass(state: DocumentState) {
  return `document-status--${state}`;
}

/* ── The fields the register shows ────────────────────────────────────────── */

/**
 * What to call a document.
 *
 * The stored `title` when somebody has set one, and the filename otherwise.
 * Never both, and never a title that is only whitespace — an operator who
 * clears the box means "go back to the filename", not "call this document
 * nothing at all".
 */
export function documentName(file: Pick<FileRecord, "name" | "title">) {
  const title = file.title?.trim();
  return title || file.name;
}

/**
 * Who uploaded it, as a person rather than an address, with the address kept.
 *
 * `uploadedByEmail` has always been written to the column and, since
 * `attachmentPayload` was widened, always served — it was the client that
 * dropped it. Null is possible for rows written before the column existed and
 * for a contractor upload made against a job token, so it is said plainly
 * rather than blamed on anybody.
 */
export function documentOwner(file: Pick<FileRecord, "uploadedByEmail">) {
  return file.uploadedByEmail?.trim() || "Not recorded";
}

/**
 * Which site it belongs to.
 *
 * The register used to derive this by matching the attachment's job against the
 * job list and reading the job's free-text `location`, falling back to the
 * literal "Shared workspace". Two things were wrong with that. The fallback was
 * written with `??`, which is nullish coalescing and therefore does not catch
 * the empty string, so a job whose location was blank produced a BLANK CELL —
 * six of thirty-seven rows on a local workspace, and the drawer rendered the
 * label "Site" over nothing at all. And matching on a display string was the
 * wrong key from the start now that the row carries a real `siteId`.
 *
 * So the id is authoritative and the name is looked up from it; a document with
 * no site says so in words.
 */
export function documentSiteLabel(
  file: Pick<FileRecord, "site" | "siteId">,
): string {
  const site = file.site?.trim();
  if (site) return site;
  return "Not linked to a site";
}

/** The literal `documentSiteLabel` returns when nothing can name the site. */
export const UNLINKED_SITE_LABEL = "Not linked to a site";

/**
 * Name every document's site, from the three sources in order of authority.
 *
 * This was a `useMemo` in portal-app.tsx and is now a pure function, for one
 * reason: the CSV export has to name the sites of rows that are NOT on screen.
 * With the register paged on the server, "the current filtered view" is a set
 * the component has never rendered, so the naming rule had to become something
 * two callers can share rather than something one component does to its own
 * props. Its behaviour is unchanged and is now unit-tested instead of matched
 * as a regex.
 *
 * The workspace's own site list keyed by `siteId` is the real answer — that is
 * the column the row is filed under. The job's free-text `location` is the
 * fallback for a document attached before site ids were written, and it is
 * checked for CONTENT rather than for null: the code this replaces wrote
 * `job?.location ?? "Shared workspace"`, and `??` is nullish coalescing, so a
 * job whose location was the empty string sailed straight past the fallback and
 * produced a BLANK Site cell — six of thirty-seven rows on a local workspace.
 *
 * The third source is nothing, and it says so: `documentSiteLabel` turns the
 * empty string into "Not linked to a site".
 */
export function withSiteNames<T extends FileRecord>(
  files: T[],
  stores: ReadonlyArray<{ id: string; name: string }>,
  requests: ReadonlyArray<{
    id: string;
    location?: string | null;
    siteId?: string | null;
  }>,
): T[] {
  const nameOf = (siteId: string | null | undefined) => {
    if (!siteId) return "";
    return stores.find((item) => item.id === siteId)?.name?.trim() ?? "";
  };
  return files.map((file) => {
    const direct = nameOf(file.siteId);
    if (direct) return { ...file, site: direct };
    const job = requests.find((item) => item.id === file.requestId);
    const location = job?.location?.trim();
    if (location) return { ...file, site: location };
    const viaJob = nameOf(job?.siteId);
    return { ...file, site: viaJob };
  });
}

/* ── Filters ──────────────────────────────────────────────────────────────── */

/**
 * The five structured filters, plus the free-text search they compose with.
 *
 * Every one of them is an empty string when inactive, which is the same
 * convention the Sites register uses (`<option value="">All statuses</option>`)
 * and means "all" without needing a sentinel value that could collide with a
 * real one.
 */
export type DocumentFilters = {
  documentType: string;
  status: string;
  expiry: string;
  site: string;
  owner: string;
};

export const emptyDocumentFilters: DocumentFilters = {
  documentType: "",
  status: "",
  expiry: "",
  site: "",
  owner: "",
};

export function hasActiveFilters(filters: DocumentFilters) {
  return Object.values(filters).some((value) => value !== "");
}

export function activeFilterCount(filters: DocumentFilters) {
  return Object.values(filters).filter((value) => value !== "").length;
}

/**
 * The expiry windows, as buckets rather than as dates.
 *
 * Every one is a view of the SAME classifier the status chip uses, so a row can
 * never be amber in the Status column and absent from the "Due soon" filter.
 * The "due soon" window prints from `EXPIRY_DUE_SOON_DAYS` and never from a
 * number typed here — the Compliance Tracker once declared its own
 * `DUE_SOON_DAYS = 30`, labelled a tile "Due within 30 days" and filled it from
 * a classifier using 60, so a certificate 45 days out was counted in a tile
 * that said 30. One constant, printed wherever the window is named.
 */
export const EXPIRY_FILTERS: ReadonlyArray<{
  value: string;
  label: string;
  states: ReadonlyArray<DocumentState>;
}> = [
  { value: "expired", label: "Expired", states: ["expired"] },
  {
    value: "due-soon",
    label: `Due within ${EXPIRY_DUE_SOON_DAYS} days`,
    states: ["due-soon"],
  },
  { value: "valid", label: "In date", states: ["valid"] },
  { value: "none", label: "No expiry set", states: ["not-recorded"] },
];

/** The document type to filter and group on: the chosen type, else the kind. */
export function documentTypeLabel(
  file: Pick<FileRecord, "documentType" | "kind">,
) {
  return file.documentType?.trim() || file.kind;
}

/**
 * The options each select offers, built from the rows in view.
 *
 * DERIVED, never declared. A hard-coded list is how a filter comes to offer
 * "Insurance certificate" on a workspace that holds none — the reader selects
 * it, gets an empty register and cannot tell whether that means "none held" or
 * "the filter is broken". Every option below is present on at least one loaded
 * row by construction, so selecting one always returns at least one document.
 *
 * The one exception is the expiry select, whose buckets are a fixed vocabulary
 * because they are windows rather than values — but they are still narrowed to
 * the buckets that actually match something, for the same reason.
 */
export function documentFilterOptions(
  files: FileRecord[],
  today: Date = new Date(),
) {
  const types = new Set<string>();
  const statuses = new Map<DocumentState, string>();
  const sites = new Set<string>();
  const owners = new Set<string>();
  const expiryBuckets = new Set<string>();

  for (const file of files) {
    types.add(documentTypeLabel(file));
    const status = documentStatus(file, today);
    statuses.set(status.state, status.label);
    sites.add(documentSiteLabel(file));
    owners.add(documentOwner(file));
    for (const bucket of EXPIRY_FILTERS) {
      if (bucket.states.includes(status.state)) expiryBuckets.add(bucket.value);
    }
  }

  const alphabetical = (a: string, b: string) => a.localeCompare(b);
  return {
    documentTypes: [...types].filter(Boolean).sort(alphabetical),
    statuses: [...statuses].map(([value, label]) => ({ value, label })),
    sites: [...sites].filter(Boolean).sort(alphabetical),
    owners: [...owners].filter(Boolean).sort(alphabetical),
    expiry: EXPIRY_FILTERS.filter((bucket) => expiryBuckets.has(bucket.value)),
  };
}

/**
 * The five selects, applied together.
 *
 * AND across the filters, so each one narrows what the previous left. The
 * search is applied separately by the caller and after this, which is what
 * makes "filters + search" one set rather than two competing ones.
 */
export function matchesDocumentFilters(
  file: FileRecord,
  filters: DocumentFilters,
  today: Date = new Date(),
) {
  if (filters.documentType && documentTypeLabel(file) !== filters.documentType) {
    return false;
  }
  if (filters.site && documentSiteLabel(file) !== filters.site) return false;
  if (filters.owner && documentOwner(file) !== filters.owner) return false;
  if (filters.status || filters.expiry) {
    const status = documentStatus(file, today);
    if (filters.status && status.state !== filters.status) return false;
    if (filters.expiry) {
      const bucket = EXPIRY_FILTERS.find((entry) => entry.value === filters.expiry);
      if (!bucket || !bucket.states.includes(status.state)) return false;
    }
  }
  return true;
}

/**
 * The free-text search, over the fields a person would actually type.
 *
 * The title and the document type are new here: a register that lets somebody
 * name a document and then cannot find it by that name has taken the name and
 * given nothing back. The filename, site, work order and owner were already
 * searchable or should have been.
 */
export function matchesDocumentSearch(file: FileRecord, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    file.name,
    file.title ?? "",
    documentTypeLabel(file),
    file.description ?? "",
    documentSiteLabel(file),
    file.requestId ?? "",
    documentOwner(file),
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/**
 * Why the register is empty, in the reader's terms.
 *
 * A blank table with a header row over it reads as a broken page rather than as
 * an answer, and the three reasons it can be blank are fixed differently: widen
 * the range, clear a filter, or change the search. Naming the wrong one sends
 * somebody to the wrong control.
 */
export function emptyRegisterReason(input: {
  windowRecognised: boolean;
  windowReason: string;
  windowLabel: string;
  inRangeCount: number;
  afterFiltersCount: number;
  filters: DocumentFilters;
  query: string;
}) {
  if (!input.windowRecognised) return input.windowReason;
  if (!input.inRangeCount) {
    return `No documents were uploaded in ${input.windowLabel}.`;
  }
  const query = input.query.trim();
  if (!input.afterFiltersCount) {
    const count = activeFilterCount(input.filters);
    return `No document in ${input.windowLabel} matches ${
      count === 1 ? "the filter" : `all ${count} filters`
    }. Clear a filter to widen the register.`;
  }
  return `No document in ${input.windowLabel} matches "${query}".`;
}

/* ── W07-11: the query the SERVER answers ─────────────────────────────────── */

/**
 * How many documents one page of the register holds.
 *
 * Named, and sent explicitly on every request rather than left to the
 * endpoint's default. `/api/files` clamps `limit` to 1..100 and defaults to
 * 100, and a caller that relies on a default cannot tell a full page from the
 * whole register — which is the exact shape of the defect this constant exists
 * to close. See `documentServerQuery`.
 */
export const DOCUMENT_PAGE_SIZE = 25;

/**
 * The page size used when walking the whole matching set.
 *
 * The endpoint's maximum, because a walk that has to happen should take as few
 * round trips as it can. It is never the size of a page on screen.
 */
export const DOCUMENT_WALK_SIZE = 100;

/**
 * How many walk pages the register will read before it stops and SAYS it
 * stopped.
 *
 * A walk is only ever entered for a predicate `/api/files` cannot express (see
 * `documentServerQuery`) or for the CSV export, and both are bounded by the
 * server-side narrowing that has already happened. The cap is here so a
 * workspace ten times the size of any we hold cannot turn one filter into an
 * unbounded fetch — and, crucially, hitting it is reported on screen rather
 * than silently truncating a total.
 */
export const DOCUMENT_WALK_MAX_PAGES = 40;

/**
 * The three labels `documentTypeLabel` falls back to when a document has no
 * `document_type` of its own. They are KINDS, not types, and `/api/files` has
 * no predicate for "document_type IS NULL", so selecting one of them is a
 * filter the server cannot answer exactly.
 */
export const KIND_FALLBACK_LABELS: ReadonlySet<string> = new Set([
  "Issue evidence",
  "Completion evidence",
  "Workspace document",
]);

const MS_PER_DAY = 86_400_000;

/**
 * `today + days` as a `YYYY-MM-DD`, counted in whole UTC days.
 *
 * The same arithmetic `expiry-status.ts` classifies with, for the same reason:
 * a date-only expiry has no time and no zone, and going through local midnight
 * moves a certificate a day for anyone west of Greenwich. If the boundary this
 * produces disagreed with the classifier's by one day, a certificate could be
 * amber on the chip and absent from the "Due soon" filter — which is precisely
 * the class of disagreement the shared classifier exists to prevent.
 */
export function registerDay(today: Date, offset: number) {
  const base = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return new Date(base + offset * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The expiry bounds that select exactly one `ExpiryState`, or null. */
function expiryBounds(state: DocumentState, today: Date) {
  switch (state) {
    // `daysRemaining < 0`, so everything strictly before today.
    case "expired":
      return { from: "", to: registerDay(today, -1) };
    // `0 <= daysRemaining <= EXPIRY_DUE_SOON_DAYS`, both ends included.
    case "due-soon":
      return { from: registerDay(today, 0), to: registerDay(today, EXPIRY_DUE_SOON_DAYS) };
    // Anything past the amber window.
    case "valid":
      return { from: registerDay(today, EXPIRY_DUE_SOON_DAYS + 1), to: "" };
    default:
      return null;
  }
}

/**
 * A range no stored date can satisfy, used to express an EMPTY answer exactly.
 *
 * "Archived" and "Expires within 60 days" selected together match nothing —
 * `documentStatus` returns `archived` for a withdrawn document whatever its
 * expiry, so the register's own rule already answers zero. Left unsent, the
 * server would count every archived document and the page would then be
 * narrowed to nothing by the client pass: a total of 14 above an empty table.
 * Sending an impossible range makes the server COUNT the zero, so the number on
 * screen is the server's answer in this case too.
 */
const IMPOSSIBLE_RANGE = { from: "9999-12-31", to: "0001-01-01" };

/**
 * The register's UI state, as one value.
 *
 * `period` is the raw token rather than a resolved window because the window is
 * a function of the clock and this object is a cache key.
 */
export type DocumentRegisterQuery = {
  page: number;
  pageSize: number;
  query: string;
  filters: DocumentFilters;
  period: string;
};

export type DocumentServerQuery = {
  /** The query string for `/api/files`, without the leading `?`. */
  search: string;
  /**
   * The same query with `limit=DOCUMENT_WALK_SIZE` and no `page`, for the CSV
   * export and for the walk. Paging is added by the walker.
   */
  walkSearch: string;
  /**
   * The register's own set — archive gate only, no filters and no search — at
   * `limit=DOCUMENT_WALK_SIZE`. The filter selects are built from this, so
   * choosing one filter cannot empty the other four's options.
   */
  optionsSearch: string;
  /**
   * The predicates `/api/files` could not express, NAMED.
   *
   * Empty is the important case: it means the server's `COUNT(*)` is the
   * register's total, one page on screen is one request, and nothing has been
   * inferred from the length of an array. Non-empty means the register must
   * read the whole matching set to count it honestly — see
   * `DOCUMENT_WALK_MAX_PAGES`.
   */
  residual: string[];
};

/**
 * Translate the register's controls into ONE server query.
 *
 * This is the whole of W07-11's "across all documents". The register used to
 * fetch `/api/files?limit=100&archived=all` and filter the result in the
 * browser, so "search" meant "search the hundred rows that happened to come
 * back" — the 101st document was not merely on another page, it was
 * unreachable, and every total inherited the same ceiling while looking like a
 * count. Every predicate below is applied by the database to the full
 * authorised set; the count is `COUNT(*)` over that same predicate; and the
 * page is a `LIMIT/OFFSET` taken afterwards.
 *
 * Where the endpoint cannot express a control, this function says so by NAME
 * rather than quietly dropping it — a filter that is silently ignored is worse
 * than one that is refused, because the reader gets a plausible answer to a
 * question nobody asked.
 */
export function documentServerQuery(input: {
  query: string;
  filters: DocumentFilters;
  period: string;
  page: number;
  pageSize: number;
  /** A site's display name to the one site id it names, or "" when unknown. */
  siteIdFor: (label: string) => string;
  today: Date;
}): DocumentServerQuery {
  const { filters } = input;
  const residual: string[] = [];
  const params = new URLSearchParams();

  /*
   * The archive gate is the server's, not a sixth filter.
   *
   * With no `archived` parameter `/api/files` applies `liveDocumentFilter()` —
   * `is_current = 1 AND archived_at IS NULL` — which is exactly the register's
   * own "current version, not withdrawn" rule. The old loader asked for
   * `archived=all` and re-implemented both halves in the browser, which is how
   * a certificate replaced twice became three rows in the table and three in
   * the tiles beside it.
   */
  if (filters.status === "archived") params.set("archived", "true");

  const optionsSearch = new URLSearchParams(params);
  optionsSearch.set("limit", String(DOCUMENT_WALK_SIZE));

  const query = input.query.trim();
  if (query) params.set("q", query);

  const documentType = filters.documentType.trim();
  if (documentType) {
    if (KIND_FALLBACK_LABELS.has(documentType)) {
      // "document_type IS NULL AND kind = ?" — `kind` alone is a superset,
      // because a row can carry both, so this is not sent as a narrowing at all.
      residual.push("document type");
    } else {
      params.set("documentType", documentType);
    }
  }

  const site = filters.site.trim();
  if (site) {
    const siteId = site === UNLINKED_SITE_LABEL ? "" : input.siteIdFor(site);
    if (siteId) params.set("siteId", siteId);
    // Either "Not linked to a site" (`site_id IS NULL`) or a name that no
    // single store answers to — a label from a job's free-text location.
    else residual.push("site");
  }

  if (filters.owner.trim()) residual.push("owner");

  /*
   * The two expiry selects, INTERSECTED, because they are both in force.
   *
   * `matchesDocumentFilters` applies Status and Expiry with AND, and each
   * names exactly one state, so the intersection is empty or a single state.
   */
  /*
   * Intersected inline rather than through a closure. A helper that reassigns
   * `states` from inside an arrow function is invisible to TypeScript's
   * control-flow analysis, so every later read narrowed to `null` and then to
   * `never` — the compiler was right that nothing it could see ever wrote a
   * value. Two statements say the same thing and typecheck.
   */
  let chosen: DocumentState[] | null = null;
  if (filters.status) chosen = [filters.status as DocumentState];
  if (filters.expiry) {
    const bucket = EXPIRY_FILTERS.find((entry) => entry.value === filters.expiry);
    const next: ReadonlyArray<DocumentState> = bucket ? bucket.states : [];
    chosen = chosen === null ? [...next] : chosen.filter((s) => next.includes(s));
  }
  if (chosen !== null) {
    if (chosen.length === 0) {
      params.set("expiryFrom", IMPOSSIBLE_RANGE.from);
      params.set("expiryTo", IMPOSSIBLE_RANGE.to);
    } else if (chosen[0] === "not-recorded") {
      // `expiry_date IS NULL`. `expiryFrom`/`expiryTo` both require
      // `IS NOT NULL`, so there is no range that selects the undated rows.
      residual.push("no expiry set");
    } else {
      const bounds = expiryBounds(chosen[0], input.today);
      if (bounds?.from) params.set("expiryFrom", bounds.from);
      if (bounds?.to) params.set("expiryTo", bounds.to);
    }
  }

  /*
   * The reporting range is an UPLOAD-date window and `/api/files` has no
   * `created_at` predicate, so any range but "all records" has to be counted
   * by reading the matching set. That is also why the register's default range
   * is "all": a register asked to search ALL documents cannot start by hiding
   * everything uploaded more than a year ago.
   */
  const period = input.period.trim();
  if (period && period !== "all") residual.push("date range");

  const walkSearch = new URLSearchParams(params);
  walkSearch.set("limit", String(DOCUMENT_WALK_SIZE));

  params.set("limit", String(input.pageSize));
  params.set("page", String(Math.max(1, Math.floor(input.page))));

  return {
    search: params.toString(),
    walkSearch: walkSearch.toString(),
    optionsSearch: optionsSearch.toString(),
    residual,
  };
}

/**
 * The register's narrowing chain, as one pure function.
 *
 * range -> CURRENT VERSION -> archive gate -> the five selects -> the search,
 * and nothing reads a halfway stage. It used to live inline in `DocumentsView`
 * over whatever `/api/files` had returned; it is here because with the register
 * paged on the server there are two callers — the page on screen, and the CSV
 * export, which covers rows the component has never rendered. Two copies of a
 * narrowing rule is how a table and its own export come to disagree.
 *
 * In the ordinary case the server has already applied every one of these and
 * this pass removes nothing: `documentServerQuery` maps each stage onto a
 * database predicate, and the server's search fields are a subset of
 * `matchesDocumentSearch`'s. It is still applied, because a page that showed a
 * row the filters exclude would be a worse failure than a redundant filter.
 */
export function narrowDocuments(
  files: FileRecord[],
  input: {
    withinPeriod: (file: FileRecord) => boolean;
    filters: DocumentFilters;
    query: string;
    today: Date;
  },
) {
  const inRange = files.filter(input.withinPeriod);
  const current = inRange.filter((file) => file.isCurrent !== false);
  const visible =
    input.filters.status === "archived"
      ? current
      : current.filter((file) => !file.archivedAt);
  const matching = visible.filter((file) =>
    matchesDocumentFilters(file, input.filters, input.today),
  );
  const filtered = matching.filter((file) =>
    matchesDocumentSearch(file, input.query),
  );
  return { inRange, current, visible, matching, filtered };
}

/**
 * Which rows of the matching set this page shows, and how it is described.
 *
 * `total` is the count of the WHOLE matching set — the server's `COUNT(*)`, or
 * the length of the set the walk read — never the length of the page. The page
 * is clamped into range rather than left to strand a reader on page 4 of a
 * result that is now two pages long: a filter that narrows while you are deep
 * in the register would otherwise answer "there is nothing here", which is a
 * claim about the data and not about the page.
 */
export function documentPageRange(input: {
  total: number;
  page: number;
  pageSize: number;
}) {
  const pageCount = Math.max(Math.ceil(input.total / input.pageSize), 1);
  const page = Math.min(Math.max(Math.floor(input.page), 1), pageCount);
  const first = input.total === 0 ? 0 : (page - 1) * input.pageSize + 1;
  const last = Math.min(page * input.pageSize, input.total);
  return { page, pageCount, first, last };
}
