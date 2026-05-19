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
   * Marketplace / removal order ID for this pallet — inherited by child packages and items.
   * Column `pallets.order_id` (migration 20260705120000_pallets_order_id; replaces legacy amazon_order_id).
   */
  order_id?: string | null;
  /** Canonical array columns on live DB. */
  pallet_photo_urls?: string[] | null;
  bol_photo_urls?: string[] | null;
  shipping_label_urls?: string[] | null;
  /** Derived from `pallet_photo_urls[0]` for UI/claims compatibility. */
  photo_url?: string | null;
  bol_photo_url?: string | null;
  manifest_photo_url?: string | null;
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
  pallet_photo_urls?: string[];
  bol_photo_urls?: string[];
  shipping_label_urls?: string[];
  photo_url?: string | null;
  bol_photo_url?: string | null;
  manifest_photo_url?: string | null;
  store_id?: string;
  notes?: string;
  /** Shipping carrier — auto-fills child Package forms. */
  carrier_name?: string | null;
  /** Marketplace / removal order ID — inherits to child packages and items (`pallets.order_id`). */
  order_id?: string | null;
  organization_id?: string; created_by?: string;
  /** Resolves tenant + super-admin target org on the server */
  actor_profile_id?: string | null;
};

export type PalletUpdatePayload = Partial<Pick<
  PalletRecord,
  | "status" | "notes" | "tracking_number"
  | "photo_url" | "bol_photo_url" | "manifest_photo_url"
  | "carrier_name" | "order_id"
>>;

export type PackageStatus = "open" | "closed" | "suspicious" | "submitted";

export type ExpectedItem = { sku: string; expected_qty: number; description?: string };

export type PackageRecord = {
  id: string; organization_id: string;
  package_code: string;
  tracking_number: string | null;
  carrier_name: string | null;
  rma_number: string | null;
  /** Printed slip / document id (`packages.id_slip_contents`). */
  id_slip_contents: string | null;
  expected_item_count: number; actual_item_count: number;
  pallet_id: string | null; status: PackageStatus;
  notes: string | null;
  manifest_url?: string | null;
  store_id?: string | null;
  stores?: { name: string; platform: string } | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string; updated_at: string;
  order_id?: string | null;
  outside_photo_urls?: string[] | null;
  inside_photo_urls?: string[] | null;
  slip_photo_urls?: string[] | null;
  /** Derived from array columns for UI/claims compatibility. */
  photo_url?: string | null;
  photo_return_label_url?: string | null;
  photo_opened_url?: string | null;
  photo_closed_url?: string | null;
  manifest_photo_url?: string | null;
  /** Client-side structured gallery mirror (not persisted on live `packages` row). */
  photo_evidence?: unknown | null;
  /** Parsed packing-slip lines (JSONB) — normalized in `normalizePackageRow` for reconciliation UI. */
  manifest_data?: ExpectedItem[] | null;
};

export type PackageInsertPayload = {
  package_code: string;
  id_slip_contents?: string | null;
  tracking_number?: string;
  carrier_name?: string; rma_number?: string; expected_item_count?: number;
  pallet_id?: string; store_id?: string; organization_id?: string; created_by?: string;
  manifest_url?: string;
  order_id?: string | null;
  photo_url?: string | null;
  photo_return_label_url?: string | null;
  photo_opened_url?: string | null;
  photo_closed_url?: string | null;
  manifest_photo_url?: string | null;
  photo_evidence?: Record<string, unknown> | null;
  actor_profile_id?: string | null;
};

export type PackageUpdatePayload = Partial<Pick<
  PackageRecord,
  | "package_code" | "id_slip_contents" | "carrier_name" | "tracking_number" | "rma_number" | "expected_item_count" | "status" | "notes" | "pallet_id" | "manifest_url"
  | "order_id"
  | "photo_url" | "photo_return_label_url" | "photo_opened_url" | "photo_closed_url" | "manifest_photo_url"
  | "photo_evidence"
>>;

export type ReturnInsertPayload = {
  lpn?: string;
  /** Seller RMA / authorization — `return_items.rma_number`. */
  rma_number?: string | null;
  marketplace: string; item_name: string;
  asin?: string;
  fnsku?: string;
  sku?: string;
  conditions: string[];
  notes?: string;
  photo_evidence?: Record<string, string | number | string[] | null> | null;
  expiration_date?: string; batch_number?: string;
  pallet_id?: string; package_id?: string;
  store_id?: string;
  /** Scanner receive — `expected_packages.id` for resolver context (not a `return_items` column on live DB). */
  expected_package_id?: string | null;
  /** @deprecated Use `expected_package_id`. */
  expected_item_id?: string | null;
  amazon_order_id?: string | null;
  order_id?: string | null;
  customer_id?: string | null;
  claim_evidence_selected_urls?: string[] | null;
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
  conditions: string[]; status: string;
  notes: string | null;
  photo_evidence: ReturnPhotoEvidenceRow;
  expiration_date: string | null; batch_number: string | null;
  store_id?: string | null;
  stores?: { name: string; platform: string } | null;
  pallet_id: string | null; package_id: string | null;
  order_id?: string | null;
  customer_id?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string; updated_at: string;
  estimated_value?: number | null;
  /** NEXT-SCANNER-02 — nullable product linkage / resolution (present when migration applied). */
  expected_item_id?: string | null;
  expected_product_id?: string | null;
  scanned_product_id?: string | null;
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
  identifier_resolution_status?: string | null;
  identifier_resolution_confidence?: number | null;
  identifier_resolution_source?: string | null;
  identifier_resolution_meta?: Record<string, unknown> | null;
  product_match_status?: string | null;
  product_review_required?: boolean | null;
  product_resolved_at?: string | null;
  product_resolved_by?: string | null;
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
