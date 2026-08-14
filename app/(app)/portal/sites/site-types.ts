"use client";

/**
 * Shared vocabulary for the Sites and Units screens.
 *
 * Every option list here is `string`, not a union: site types, statuses and
 * unit categories are rows an admin edits, so the compiler must not own them.
 */

import { chipInk } from "../chip-ink";

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

export type ComplianceRecord = {
  id: string;
  siteId: string;
  kind: string;
  status: string;
  expiryDate: string | null;
  attachmentId: string | null;
  notRequired: boolean;
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

/** Dates are shown DD/MM/YYYY in Europe/London, per the platform convention. */
export function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(parsed);
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
