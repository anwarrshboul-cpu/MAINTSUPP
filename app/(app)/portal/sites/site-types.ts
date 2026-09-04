"use client";

/**
 * Shared vocabulary for the Sites and Units screens.
 *
 * Every option list here is `string`, not a union: site types, statuses and
 * unit categories are rows an admin edits, so the compiler must not own them.
 */

import { chipInk } from "../chip-ink";
import { formatDate as sharedFormatDate } from "../../../lib/format-date";
import type { ComplianceState } from "../../../lib/types";

export type OptionChoice = {
  id: string;
  value: string;
  label: string;
  colourHex: string;
  textColour: string;
  position: number;
  isDefault: boolean;
  active: boolean;
  system: boolean;
  usage?: number;
};

export type SiteRecord = {
  id: string;
  name: string;
  slug: string | null;
  code: string | null;
  siteTypeValue: string | null;
  type: string;
  status: string;
  region: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postcode: string | null;
  country: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  managerName: string | null;
  managerPhone: string | null;
  managerEmail: string | null;
  landlord: string | null;
  managingAgent: string | null;
  outOfHoursContact: string | null;
  accessMethod: string | null;
  accessContact: string | null;
  accessUrl: string | null;
  accessNotes: string | null;
  openingHours: string | null;
  deliveryRestrictions: string | null;
  parkingNotes: string | null;
  keyAlarmNotes: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  breakClause: string | null;
  rentReview: string | null;
  serviceChargePence: number | null;
  /** Annual maintenance budget in pence. NULL means not set, not zero. */
  annualBudgetPence: number | null;
  mondayMaintenanceName: string | null;
  mondayComplianceName: string | null;
  notes: string | null;
  /**
   * Every OTHER spelling this site has ever answered to, as written — the
   * `site_aliases.alias` column, not `normalised`.
   *
   * OPTIONAL BECAUSE THE PAYLOAD DOES NOT CARRY IT YET, and the honest thing is
   * to say so in the type rather than to declare a field the server never
   * sends. `site_aliases` is real (db/schema.ts), it is written on every rename
   * by `PATCH /api/sites`, `app/lib/sites-repository.ts` already exports
   * `listAliases(db, organisationId)`, and `resolveSiteByName` already searches
   * it — but `GET /api/sites` does not select it, so the register cannot find a
   * site by a name it used to have. The filter in sites-manager.tsx reads this
   * field defensively and starts working the moment the route attaches it; the
   * route change is not this lane's to make.
   *
   * The two `monday*Name` columns above are a different thing and both are
   * needed: they are the CURRENT spelling on each of the two monday boards,
   * one each, whereas this is the unbounded history.
   */
  aliases?: string[];
  active: boolean;
  position: number;
  updatedAt: string;
};

export type SiteGroupRecord = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  colourHex: string;
  active: boolean;
  siteIds: string[];
};

export type UnitRecord = {
  id: string;
  siteId: string;
  name: string;
  category: string;
  status: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  assetTag: string | null;
  locationInSite: string | null;
  installedAt: string | null;
  warrantyExpiry: string | null;
  purchasePricePence: number | null;
  supplier: string | null;
  lastServicedAt: string | null;
  nextServiceDueAt: string | null;
  serviceIntervalMonths: number | null;
  notes: string | null;
};

export type ServiceRecord = {
  id: string;
  unitId: string;
  performedAt: string;
  serviceType: string;
  contractorName: string | null;
  outcome: string | null;
  costPence: number | null;
  notes: string | null;
  recordedByEmail: string | null;
};

/**
 * One compliance requirement for one site, as `GET /api/sites?id=` serves it.
 *
 * This used to be a raw `compliance_documents` row and `status` used to be
 * whatever string was stored in that column, whenever it was written. It is now
 * the DERIVED register record (`readSiteComplianceRecords` in
 * app/lib/compliance-register.ts): `status` is recomputed on every read and is
 * one of the five words the whole product speaks, and the board's own documents
 * appear here for the first time — previously the tab could only ever show
 * override rows, of which the client's workspace has none.
 *
 * The four fields the screen already read — `id`, `kind`, `expiryDate`,
 * `notRequired` — are unchanged and in the same places, which is why the reader
 * was built to return this shape rather than the register's leaner
 * `ComplianceItem`.
 */
export type ComplianceRecord = {
  id: string;
  siteId: string;
  kind: string;
  /** The derived five-word state. Never a stored string. */
  status: ComplianceState;
  expiryDate: string | null;
  attachmentId: string | null;
  notRequired: boolean;
  /** The same value as `status`, under the name the rest of the platform uses. */
  state: ComplianceState;
  /** Real attachment count — board file columns included. */
  fileCount: number;
  /** The Store Documentation row this came from, or null. */
  itemId: string | null;
  slotKey: string | null;
  /** Whether a date is expected for this requirement at all. */
  tracksExpiry: boolean;
};

export type DuplicateWarning = { id: string; name: string; status: string };

export class ApiError extends Error {
  duplicates?: DuplicateWarning[];
  requiresConfirmation?: boolean;
  requiresReassignment?: boolean;
  usage?: number;

  constructor(message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.duplicates = extra.duplicates as DuplicateWarning[] | undefined;
    this.requiresConfirmation = Boolean(extra.requiresConfirmation);
    this.requiresReassignment = Boolean(extra.requiresReassignment);
    this.usage = extra.usage as number | undefined;
  }
}

/**
 * A SITES URL, ADDRESSED TO ONE REGISTER.
 *
 * The server decides the scope — `resolveRegisterScope` in
 * `app/lib/register-scope.ts` reads the organisation off the session, looks the
 * section up inside it, and refuses anything that is not a Sites instance. This
 * only says WHICH register the screen is asking about, and it is the one place
 * that says it, so a call site cannot forget the parameter and quietly read the
 * canonical estate instead.
 *
 * `null` is the canonical register, exactly as it is in the database: the
 * workspace's own Sites screen, which has no board behind it. Absent parameter,
 * canonical rows — so every caller that predates instances is unchanged.
 */
export function scopedUrl(url: string, sectionKey: string | null) {
  if (!sectionKey) return url;
  return `${url}${url.includes("?") ? "&" : "?"}section=${encodeURIComponent(sectionKey)}`;
}

export async function api<T>(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      typeof payload.error === "string" ? payload.error : "That did not work.",
      payload,
    );
  }
  return payload as T;
}

/**
 * DD/MM/YYYY, through the one formatter the platform writes dates with.
 *
 * The zone is not passed on purpose: a bare `YYYY-MM-DD` — which is what every
 * lease and review date on a site is — never reaches `Date` inside the shared
 * formatter, so it cannot shift a day whatever zone the reader is in. A value
 * carrying a time is a moment and reads in the reader's own zone, as it does
 * everywhere else.
 */
export function formatDate(value: string | null | undefined) {
  return sharedFormatDate(value);
}

/** Money is held in pence. Divide only at the point of display. */
export function formatMoney(pence: number | null | undefined) {
  if (pence === null || pence === undefined) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(pence / 100);
}

export function daysUntil(value: string | null | undefined) {
  if (!value) return null;
  const target = new Date(`${value.slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(target)) return null;
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - start) / 86_400_000);
}

export function labelFor(options: OptionChoice[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}

export function styleFor(options: OptionChoice[], value: string) {
  const match = options.find((option) => option.value === value);
  const background = match?.colourHex ?? "#5c82af";
  // The stored `textColour` is kept whenever it is legible on its own ground;
  // `chipInk` only steps in for the pairs that are not. See chip-ink.ts.
  return { backgroundColor: background, color: chipInk(background, match?.textColour) };
}
