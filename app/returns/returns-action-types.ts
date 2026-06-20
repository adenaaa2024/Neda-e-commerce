/**
 * Return / package / pallet row types — kept out of `actions.ts` because `"use server"`
 * modules may only export async functions (Next.js).
 */
import type { ReturnPhotoEvidenceRow } from "../../lib/return-photo-evidence";

export interface OrgSettings {
  is_ai_label_ocr_enabled: boolean;
  is_ai_packing_slip_ocr_enabled: boolean;
}

export type PalletStatus = "open" | "closed" | "submitted";

export type PalletRecord = {
  id: string; organization_id: string;
  pallet_number: string;
  tracking_number?: string | null;
  /**
   * Shipping carrier for this pallet — inherited down to child packages on creation.
   * Added in migration 20260418_pallets_carrier_amazon_order_id.
   */
  carrier_name?: string | null;
  /**
   * Marketplace order ID for this pallet — inherited by child packages and items.
   * Column `pallets.order_id` (renamed from `amazon_order_id`).
   */
  order_id?: string | null;
  pallet_photo_urls?: string[];
  bol_photo_urls?: string[];
  shipping_label_urls?: string[];
  status: PalletStatus; notes: string | null; item_count: number;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string; updated_at: string;
  store_id?: string | null;
  stores?: { name: string; platform: string } | null;
  child_packages_count?: number;
  child_returns_count?: number;
};

export type PalletInsertPayload = {
  pallet_number: string;
  pallet_photo_urls?: string[] | null;
  bol_photo_urls?: string[] | null;
  shipping_label_urls?: string[] | null;
  store_id?: string;
  notes?: string;
  /** Shipping carrier — auto-fills child Package forms. */
  carrier_name?: string | null;
  /** Marketplace order ID — inherits to child packages and items (`pallets.order_id`). */
  order_id?: string | null;
  organization_id?: string; created_by?: string;
  /** Resolves tenant + super-admin target org on the server */
  actor_profile_id?: string | null;
};

export type PalletUpdatePayload = Partial<Pick<
  PalletRecord,
  | "status" | "notes" | "tracking_number"
  | "pallet_photo_urls" | "bol_photo_urls" | "shipping_label_urls"
  | "carrier_name" | "order_id"
>>;

export type PackageStatus = "open" | "closed" | "suspicious" | "submitted";

export type ExpectedItem = {
  sku: string;
  expected_qty: number;
  description?: string;
  asin?: string | null;
  fnsku?: string | null;
  /** Deterministic resolver output when `store_id` + identifiers allow a map lookup. */
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
  identifier_resolution_status?: string | null;
  identifier_resolution_confidence?: number | null;
};

export type PackageRecord = {
  id: string; organization_id: string;
  package_code: string; tracking_number: string | null;
  carrier_name: string | null;
  rma_number: string | null;
  expected_item_count: number; actual_item_count: number;
  pallet_id: string | null; status: PackageStatus;
  discrepancy_note: string | null;
  manifest_url?: string | null;
  store_id?: string | null;
  stores?: { name: string; platform: string } | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string; updated_at: string;
  order_id?: string | null;
  inside_photo_urls?: string[];
  outside_photo_urls?: string[];
  slip_photo_urls?: string[];
  /** Parsed packing-slip lines (JSONB) — normalized in `normalizePackageRow` for reconciliation UI. */
  manifest_data?: ExpectedItem[] | null;
  /**
   * Raw `packages.manifest_data` JSON when stored as an object (scanner ops: `operator_item_scan`, `box_slip_vision`).
   * Read-only list payload — not written back on update.
   */
  manifest_data_raw?: Record<string, unknown> | null;
};

export type PackageInsertPayload = {
  package_code: string; tracking_number?: string;
  carrier_name?: string; rma_number?: string; expected_item_count?: number;
  pallet_id?: string; store_id?: string; organization_id?: string; created_by?: string;
  manifest_url?: string;
  /** Optional slip lines — persisted on `packages.manifest_data` with resolver fields when store is known. */
  manifest_data?: ExpectedItem[] | null;
  order_id?: string | null;
  inside_photo_urls?: string[] | null;
  outside_photo_urls?: string[] | null;
  slip_photo_urls?: string[] | null;
  /** Wizard-only — mapped to array columns on insert. */
  photo_evidence?: Record<string, unknown> | null;
  manifest_photo_url?: string | null;
  actor_profile_id?: string | null;
};

export type PackageUpdatePayload = Partial<Pick<
  PackageRecord,
  | "carrier_name" | "tracking_number" | "rma_number" | "expected_item_count" | "status" | "discrepancy_note" | "pallet_id" | "manifest_url"
  | "order_id"
  | "inside_photo_urls" | "outside_photo_urls" | "slip_photo_urls"
  | "manifest_data"
>> & {
  /** Edit wizard / manifest upload — mapped to array columns server-side. */
  photo_evidence?: unknown | null;
  manifest_photo_url?: string | null;
};

export type ReturnInsertPayload = {
  lpn?: string;
  /** Seller RMA / authorization — `return_items.rma_number`. */
  rma_number?: string | null;
  marketplace: string; item_name: string;
  asin?: string;
  fnsku?: string;
  sku?: string;
  product_identifier?: string;
  conditions: string[];
  notes?: string;
  photo_evidence?: Record<string, string | number | string[] | null> | null;
  expiration_date?: string; batch_number?: string;
  /** Units in this scan batch (default 1). Requires migration 20260608180000 on DB. */
  scanned_quantity?: number;
  pallet_id?: string; package_id?: string;
  store_id?: string;
  amazon_order_id?: string | null;
  order_id?: string | null;
  customer_id?: string | null;
  claim_evidence_selected_urls?: string[] | null;
  /** FK to expected_packages row this unit was received against (scanner split). */
  expected_item_id?: string | null;
  organization_id?: string; created_by?: string;
  actor_profile_id?: string | null;
};

export type ReturnRecord = {
  id: string; organization_id: string;
  lpn: string | null;
  /** Seller RMA / authorization — column on `return_items` (optional). */
  rma_number?: string | null;
  inherited_tracking_number?: string | null;
  inherited_carrier?: string | null;
  marketplace: string;
  /** FK to global `marketplaces` for channel icon (optional). */
  marketplace_id?: string | null;
  marketplaces?: { icon_url?: string | null; slug?: string; name?: string } | null;
  item_name: string;
  asin?: string | null;
  fnsku?: string | null;
  sku?: string | null;
  product_identifier?: string | null;
  /** Legacy catalog FK — compared to resolver output for `mismatch` status. */
  product_id?: string | null;
  conditions: string[]; status: string;
  notes: string | null;
  photo_evidence: ReturnPhotoEvidenceRow;
  expiration_date: string | null; batch_number: string | null;
  store_id?: string | null;
  stores?: { name: string; platform: string } | null;
  pallet_id: string | null; package_id: string | null;
  /** FK to expected_packages row this unit was received against (scanner split). */
  expected_item_id?: string | null;
  order_id?: string | null;
  customer_id?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string; updated_at: string;
  estimated_value?: number | null;
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
  identifier_resolution_status?: string | null;
  identifier_resolution_confidence?: number | null;
  /** Server-hydrated `products.product_name` for list views (read-only display). */
  catalog_product_name?: string | null;
};

export type ReturnUpdatePayload = Partial<Pick<
  ReturnRecord,
  | "lpn" | "rma_number" | "item_name" | "notes" | "status"
  | "conditions" | "expiration_date" | "batch_number"
  | "package_id" | "pallet_id"
  | "photo_evidence"
  | "asin" | "fnsku" | "sku" | "product_identifier" | "store_id" | "marketplace"
  | "order_id"
>>;

export type AuditLogRecord = {
  id: string; organization_id: string;
  return_id: string | null; pallet_id: string | null;
  action: string; field: string | null;
  old_value: string | null; new_value: string | null;
  actor: string; created_at: string;
};

export type DashboardSnapshot = {
  returnsToday: number;
  palletCount: number;
  packageCount: number;
  claimsReadyToSend: number;
  returnsEstimatedValueUsd: number;
};

export type ReturnsAnalyticsPayload = {
  totalReturns: number;
  totalPallets: number;
  avgProcessingHours: number;
  conditionSlices: { name: string; value: number }[];
  carrierBars: { name: string; count: number }[];
  operatorStats: { operator: string; count: number }[];
};

export type CommandCenterTrendPoint = {
  date: string;
  count: number;
};

export type CommandCenterClaimFunnel = {
  scanned: number;
  eligible: number;
  draft: number;
  ready: number;
  submitted: number;
};

export type CommandCenterActionItem = {
  id: string;
  type:
    | "missing_evidence"
    | "product_link"
    | "stale_package"
    | "open_pallet"
    | "claim_ready"
    | "package_hold";
  label: string;
  reference: string | null;
  createdAt: string | null;
  status: string;
  href: string | null;
};

export type CommandCenterHealth = {
  lastImportAt: string | null;
  lastImportLabel: string | null;
  productJobStatus: string | null;
  productJobAt: string | null;
  lastAuditAt: string | null;
  lastAuditAction: string | null;
  importErrorsHint: string | null;
  scannerActivityHint: string | null;
  /** Removal shipment API sync observability (production go-live). */
  lastSuccessfulRemovalImportAt: string | null;
  lastSuccessfulRemovalImportType: string | null;
  lastFailedRemovalImportAt: string | null;
  latestShipmentDate: string | null;
  expectedPackagesDerivedCount: number | null;
  expectedDataFreshnessHint: string | null;
  nextScheduledSyncAt: string | null;
  removalScheduleSource: string | null;
  lastCronSuccessAt: string | null;
  lastCronFailedAt: string | null;
  lastCronStatus: string | null;
};

/** Rich command center payload for Neda-style dashboard UI. */
export type CommandCenterPayload = {
  snapshot: DashboardSnapshot;
  openPallets: number;
  openPackages: number;
  expectedItems: number;
  scannedItems: number;
  missingEvidence: number;
  needsProductLink: number;
  productLinkResolved: number;
  claimsDraft: number;
  returnsTrend: CommandCenterTrendPoint[];
  claimFunnel: CommandCenterClaimFunnel;
  conditionSlices: { name: string; value: number }[];
  actionQueue: CommandCenterActionItem[];
  health: CommandCenterHealth;
};

/** Legacy command center snapshot (mapper from dashboard snapshot). */
export type CommandCenterSnapshot = {
  returnsToday: number;
  openPackageCount: number;
  openPalletCount: number;
  expectedItemsTotal: number;
  scannedItemsTotal: number;
  readyClaimsValueUsd: number;
  missingEvidenceCount: number;
  needsProductLinkCount: number;
  returnsTrend7d: { date: string; count: number }[];
  returnsTrend30d: { date: string; count: number }[];
  productLinkage: { resolved: number; unresolved: number };
  claimFunnel: { stage: string; count: number }[];
  actionQueue: {
    id: string;
    kind: string;
    title: string;
    detail: string;
    href?: string | null;
    createdAt: string | null;
  }[];
  health: {
    lastSyncAt: string | null;
    lastProductUpdateAt: string | null;
    apiAutomationStatus: string;
    importErrorsCount: number;
  };
  claimsReadyToSend: number;
  returnsEstimatedValueUsd: number;
};
