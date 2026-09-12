/**
 * The Assets screens' shared vocabulary.
 *
 * The shape of what `/api/assets` sends, and nothing else. Formatting,
 * fetching and option lookup all come from `../sites/site-types`, because the
 * Sites screens already own those and a second `formatMoney` is how two
 * registers come to print money differently.
 *
 * Pure: no hooks, no JSX, no clock.
 */

import type { OptionChoice } from "../sites/site-types";
import type { AssetSpec } from "../../../lib/asset-model";

export type { AssetSpec };

/** One row of the register, as the list endpoint sends it. */
export type AssetRow = {
  id: string;
  siteId: string;
  name: string;
  assetNumber: string | null;
  assetTag: string | null;
  kind: string;
  category: string;
  status: string;
  manufacturer: string | null;
  model: string | null;
  partNumber: string | null;
  serialNumber: string | null;
  specification: string | null;
  specs: string | null;
  colour: string | null;
  colourCode: string | null;
  paintReference: string | null;
  quantity: number | null;
  locationInSite: string | null;
  supplier: string | null;
  supplierContractorId: string | null;
  supplierReference: string | null;
  replacementPartNumber: string | null;
  replacementModel: string | null;
  replacementNotes: string | null;
  replacementCostPence: number | null;
  lastReplacedAt: string | null;
  warrantyExpiry: string | null;
  nextServiceDueAt: string | null;
  parentUnitId: string | null;
  primaryImageId: string | null;
  notes: string | null;
  updatedAt: string | null;
};

/** The whole record, as the single-asset endpoint sends it. */
export type AssetRecord = AssetRow & {
  organisationId: string;
  installedAt: string | null;
  lastServicedAt: string | null;
  serviceIntervalMonths: number | null;
  purchasePricePence: number | null;
  supplierEmail: string | null;
  supplierPhone: string | null;
  supplierUrl: string | null;
  replacementIntervalMonths: number | null;
  replacementSpecification: string | null;
  replacementSupplier: string | null;
  createdByEmail: string | null;
  updatedByEmail: string | null;
  createdAt: string | null;
};

export type AssetHistoryRow = {
  id: string;
  performedAt: string;
  eventType: string;
  serviceType: string;
  contractorName: string | null;
  outcome: string | null;
  costPence: number | null;
  previousDetail: string | null;
  replacementDetail: string | null;
  notes: string | null;
  recordedByEmail: string | null;
};

export type AssetFileRow = {
  id: string;
  originalName: string;
  contentType: string;
  byteSize: number;
  title: string | null;
  createdAt: string | null;
  uploadedByEmail: string | null;
  inlineUrl: string;
  downloadUrl: string;
};

export type AssetRelation = {
  id: string;
  name: string;
  assetNumber: string | null;
  kind?: string;
  status?: string;
  /** Present on the editor's candidate list, so it can narrow by site. */
  siteId?: string;
};

/** Every picker the form and the filters draw, resolved by the server once. */
export type AssetReference = {
  categories: OptionChoice[];
  statuses: OptionChoice[];
  sites: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
  kinds: Array<{ value: string; label: string }>;
  events: readonly string[];
};

export type AssetTotals = {
  all: number;
  equipment: number;
  replacementParts: number;
  needsReplacement: number;
};

export type AssetListPayload = AssetReference & {
  assets: AssetRow[];
  totals: AssetTotals;
};

export type AssetDetailPayload = AssetReference & {
  asset: AssetRecord;
  history: AssetHistoryRow[];
  files: AssetFileRow[];
  children: AssetRelation[];
  parent: AssetRelation | null;
};

/**
 * The form's own shape — every field a string, because every control is one.
 *
 * Kept apart from `AssetRecord` deliberately. A form bound to nullable numbers
 * and nullable dates has to decide what an empty box means on every keystroke;
 * binding to strings and converting once on submit means the "did they clear it
 * or never fill it in" question is asked in exactly one place.
 */
export type AssetForm = {
  siteId: string;
  name: string;
  kind: string;
  category: string;
  status: string;
  assetTag: string;
  manufacturer: string;
  model: string;
  partNumber: string;
  serialNumber: string;
  specification: string;
  colour: string;
  colourCode: string;
  paintReference: string;
  quantity: string;
  locationInSite: string;
  parentUnitId: string;
  installedAt: string;
  warrantyExpiry: string;
  lastServicedAt: string;
  serviceIntervalMonths: string;
  purchasePrice: string;
  supplier: string;
  supplierContractorId: string;
  supplierReference: string;
  supplierEmail: string;
  supplierPhone: string;
  supplierUrl: string;
  lastReplacedAt: string;
  replacementIntervalMonths: string;
  replacementPartNumber: string;
  replacementModel: string;
  replacementSpecification: string;
  replacementSupplier: string;
  replacementNotes: string;
  replacementCost: string;
  notes: string;
  specs: AssetSpec[];
};

/** Pence back into the pounds a text input shows. Empty, never "0.00". */
function poundsField(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return "";
  return (pence / 100).toFixed(2);
}

function str(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export function emptyAssetForm(siteId = ""): AssetForm {
  return {
    siteId,
    name: "",
    kind: "equipment",
    category: "",
    status: "",
    assetTag: "",
    manufacturer: "",
    model: "",
    partNumber: "",
    serialNumber: "",
    specification: "",
    colour: "",
    colourCode: "",
    paintReference: "",
    quantity: "",
    locationInSite: "",
    parentUnitId: "",
    installedAt: "",
    warrantyExpiry: "",
    lastServicedAt: "",
    serviceIntervalMonths: "",
    purchasePrice: "",
    supplier: "",
    supplierContractorId: "",
    supplierReference: "",
    supplierEmail: "",
    supplierPhone: "",
    supplierUrl: "",
    lastReplacedAt: "",
    replacementIntervalMonths: "",
    replacementPartNumber: "",
    replacementModel: "",
    replacementSpecification: "",
    replacementSupplier: "",
    replacementNotes: "",
    replacementCost: "",
    notes: "",
    specs: [],
  };
}

/** An existing record as the editor's fields. */
export function toAssetForm(asset: AssetRecord, specs: AssetSpec[]): AssetForm {
  return {
    siteId: asset.siteId,
    name: asset.name,
    kind: asset.kind,
    category: asset.category,
    status: asset.status,
    assetTag: str(asset.assetTag),
    manufacturer: str(asset.manufacturer),
    model: str(asset.model),
    partNumber: str(asset.partNumber),
    serialNumber: str(asset.serialNumber),
    specification: str(asset.specification),
    colour: str(asset.colour),
    colourCode: str(asset.colourCode),
    paintReference: str(asset.paintReference),
    quantity: str(asset.quantity),
    locationInSite: str(asset.locationInSite),
    parentUnitId: str(asset.parentUnitId),
    installedAt: str(asset.installedAt),
    warrantyExpiry: str(asset.warrantyExpiry),
    lastServicedAt: str(asset.lastServicedAt),
    serviceIntervalMonths: str(asset.serviceIntervalMonths),
    purchasePrice: poundsField(asset.purchasePricePence),
    supplier: str(asset.supplier),
    supplierContractorId: str(asset.supplierContractorId),
    supplierReference: str(asset.supplierReference),
    supplierEmail: str(asset.supplierEmail),
    supplierPhone: str(asset.supplierPhone),
    supplierUrl: str(asset.supplierUrl),
    lastReplacedAt: str(asset.lastReplacedAt),
    replacementIntervalMonths: str(asset.replacementIntervalMonths),
    replacementPartNumber: str(asset.replacementPartNumber),
    replacementModel: str(asset.replacementModel),
    replacementSpecification: str(asset.replacementSpecification),
    replacementSupplier: str(asset.replacementSupplier),
    replacementNotes: str(asset.replacementNotes),
    replacementCost: poundsField(asset.replacementCostPence),
    notes: str(asset.notes),
    specs,
  };
}

/** A human size for the files list. Bytes are not a unit anybody reads. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImage(contentType: string): boolean {
  return contentType.startsWith("image/");
}
