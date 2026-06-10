"use server";

import { supabaseServer } from "@/lib/supabase-server";
import { getSessionUserIdFromCookies } from "@/lib/supabase-server-auth";
import { loadTenantProfile, resolveWriteOrganizationId } from "@/lib/server-tenant";
import { canPickWorkspaceOrganizationForTenantBranding } from "@/lib/tenant-branding-permissions";
import { isUuidString } from "@/lib/uuid";
import {
  filterPackageItemDiscrepancyTags,
  packageItemRequiresEvidencePhotos,
} from "@/lib/scanner/item-unit-discrepancy-tags";
import {
  buildPackageFinalizeDiscrepancyNote,
  type FinalizePackageReceiveCloseRpcResult,
} from "@/lib/scanner/package-finalize-close";
import { parseOperatorItemScanFromManifestData } from "@/lib/scanner/package-operator-item-scan";
import {
  assertPackageReceiveOpenForEdits,
  loadPackageOperatorItemScanManifest,
} from "@/lib/scanner/package-receive-edit-guard";
import { guardBatchQuantityBackendError } from "@/lib/scanner/batch-quantity-backend-guard";
import { computeSlipLineExpectedVsReceived } from "@/lib/scanner/slip-contents-missing-expected";
import { buildPalletShipmentReviewPreview } from "@/lib/scanner/pallet-shipment-review-preview";
import type { PalletShipmentReviewPreview } from "@/lib/scanner/pallet-shipment-review-types";
import { buildSlipShipmentValidationPreview } from "@/lib/scanner/slip-shipment-validation";
import type { BoxCloseReviewSnapshot } from "@/lib/scanner/box-close-review";
import type { PalletCloseReviewSnapshot } from "@/lib/scanner/pallet-close-review";
import { buildPalletCloseReviewModelFromPreview } from "@/lib/scanner/pallet-close-review";
import type { ShipmentCloseReviewSnapshot } from "@/lib/scanner/shipment-close-review";
import { buildShipmentCloseReviewModelFromPreview } from "@/lib/scanner/shipment-close-review";
import {
  mergePalletPhotoEvidenceFinalize,
  mergePalletPhotoEvidenceReopen,
  readPalletCloseState,
} from "@/lib/scanner/pallet-operator-close-manifest";
import {
  mergePackageManifestShipmentCloseFinalize,
  mergePackageManifestShipmentCloseReopen,
  mergePalletPhotoEvidenceShipmentCloseFinalize,
  mergePalletPhotoEvidenceShipmentCloseReopen,
  readShipmentCloseFromPackageManifest,
  readShipmentCloseFromPalletPhotoEvidence,
} from "@/lib/scanner/shipment-operator-close-manifest";
import type { SlipShipmentValidationPreview } from "@/lib/scanner/slip-shipment-validation-types";
import {
  mergePackageManifestEmptyBox,
  mergePackageManifestItemScanFinalize,
  packageManifestHasEmptyBox,
  type PackageItemScanEvidenceRefs,
} from "@/lib/scanner/package-empty-box-manifest";
import {
  mergePackageManifestReceiveReopen,
  packageReceiveStateIsFinalized,
} from "@/lib/scanner/package-receive-state-contract";
import { manualOverrideReturnItemProductResolution } from "@/app/scanner/operator-mobile/item-actions";
import {
  buildOperatorMissingReviewEntry,
  detectMissingReviewConflicts,
  mergePackageManifestMissingReview,
  mergePackageManifestMissingReviewConflicts,
  mergePackageManifestShortageFinalize,
  missingReviewEntryForSlip,
  missingReviewRecordedQtyForSlip,
  readMissingReviewEntries,
  removeMissingReviewEntryFromManifest,
  type OperatorMissingReviewEntry,
} from "@/lib/scanner/package-missing-review-manifest";
import type { OperatorStoreOption } from "@/lib/scanner/operator-session";
import {
  findPalletByIdForOperator,
  findPalletByTrackingOrNumber,
  findPalletInOrgByScanCode,
  type OperatorPalletTrackingRow,
} from "@/lib/scanner/operator-pallet-tracking";
import {
  assertOperatorMobilePermission,
  isElevatedOperatorMobileCorrectionRole,
  userHasOperatorMobilePermission,
} from "@/lib/operator-mobile-permission-guard";
import {
  OPERATOR_MOBILE_MOVE_BOX,
  OPERATOR_MOBILE_VOID_BOX,
  OPERATOR_MOBILE_EDIT_ITEM,
  OPERATOR_MOBILE_DELETE_ITEM,
  OPERATOR_MOBILE_CLOSE_PALLET,
  OPERATOR_MOBILE_REOPEN_PALLET,
  OPERATOR_MOBILE_CLOSE_SHIPMENT_REVIEW,
  OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW,
  OPERATOR_MOBILE_DELETE_NOT_SCANNED_UNIT_MESSAGE,
  OPERATOR_MOBILE_DELETE_ORG_MISMATCH_MESSAGE,
  OPERATOR_MOBILE_DELETE_OWNERSHIP_MESSAGE,
} from "@/lib/operator-mobile-permissions";
import { softDeleteShipmentEntryBaselineReturnItems } from "@/lib/scanner/operator-active-scanned-counts";
import { shouldExcludeReturnItemFromScannerCounts } from "@/lib/scanner/return-items-test-data-guard";
import {
  catalogIlikePattern,
  classifyCatalogSearchQuery,
  isIdentifierCatalogQuery,
} from "@/lib/search/catalog-text-search";
import { normalizeTrackingKey } from "@/lib/scanner/tracking-normalize";
import { lookupShipmentEntryScanCode, type ShipmentEntryLookupResult } from "@/lib/scanner/shipment-entry-lookup";
import {
  fetchVInventoryItemStatusLinesExact,
  fetchVInventoryItemStatusLinesForTrackingNormalized,
  type InventoryViewMatchField,
  type VInventoryStatusRow,
} from "@/lib/scanner/v-inventory-status";
import {
  allocateExpectedItemsForReturnItemIds,
  buildReceiveScopeKey,
  fetchPackageReceiveContext,
  humanizeExpectedAllocationError,
  isNoAllocatableExpectedAllocationError,
  moveExpectedItemsForPackageScope,
  releaseExpectedItemUnit,
  releaseExpectedItemsForPackage,
  resolveAllocatableExpectedPackageHint,
  softVoidPalletWithExpectedRelease,
  softVoidReturnItemWithExpectedRelease,
  syncReturnItemsPalletForPackage,
} from "@/lib/scanner/receive-expected-with-split";
import { extractSlipOrderTokenForPalletCompare } from "@/lib/scanner/amazon-ra-order-id";
import {
  resolveAuditActorForSession,
  resolveDisplayLabelForUserId,
  resolveDisplayLabelsForUserIds,
} from "@/lib/server-audit-actor";
import { sanitizePublicMediaUrlStrings } from "@/lib/entity-photo-evidence";
import { insertIntakeBoxPackage } from "@/lib/scanner/operator-box-intake";
import { insertUnknownPackageForTrackingCode } from "@/lib/scanner/operator-unknown-package";
import {
  fetchStoreDisplayNameForOrganization,
  formatUnauthorizedPackageInStoreMessage,
  formatUnauthorizedTrackingInStoreMessage,
} from "@/lib/scanner/operator-store-display";
import { formatDuplicatePackingSlipMessage } from "@/lib/scanner/operator-slip-duplicate";
import { formatSupabaseActionError } from "@/lib/supabase-action-error";
import { enrichSlipContentsProductLinksAfterReplace } from "@/lib/scanner/enrich-slip-contents-product-links";
import { slipVisionLineIdentifierFields } from "@/lib/scanner/slip-vision-line-identifiers";
import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { insertReturn } from "@/app/returns/actions";
import { promoteScannerReturnItemToClaimStructures } from "@/lib/scanner-operator-claim-promote";
import { isExpectedScannerClaimPromoteSkipReason } from "@/lib/scanner-claim-promote-guard";
import { RETURN_ITEMS_TABLE } from "@/app/returns/returns-constants";
import {
  buildOperatorItemUnitPhotoEvidence,
  splitOperatorItemUnitPhotos,
  type ReturnPhotoEvidenceRow,
} from "@/lib/return-photo-evidence";
import {
  ITEM_UNIT_SELLABLE_OK_TAG,
  normalizeItemUnitDiscrepancySelection,
  type ItemUnitDiscrepancyTagKey,
} from "@/lib/scanner/item-unit-discrepancy-tags";
import {
  appendOffSlipAuditNote,
  returnItemNotesMarkOffSlip,
} from "@/lib/scanner/item-scan-off-slip";
import {
  itemBatchUnitSaveAsOffSlip,
  OPERATOR_ITEM_BATCH_MAX_QUANTITY,
  type ItemBatchAllocationInput,
} from "@/lib/scanner/item-batch-allocation";
import {
  coalesceSlipRowFnsku,
  coalesceSlipRowUpc,
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
} from "@/lib/scanner/operator-slip-item-resolve";
import {
  buildProductLinkageDisplayContract,
  fetchProductNamesByResolvedIds,
  type ProductsLookupClient,
  type ProductLinkageDisplayContract,
} from "@/lib/scanner/product-linkage-display-contract";
import { RETURN_SCANNER_LINKAGE_SELECT } from "@/app/returns/returns-constants";
import { resolveProductForScannerItem } from "@/lib/scanner/resolve-product-for-scanner-item";
import { buildOperatorBarcodeResolverFields } from "@/lib/scanner/operator-barcode-preview-input";
import {
  buildProductLinkageFromResolveResult,
  hydrateReturnItemProductLinkage,
} from "@/lib/scanner/hydrate-return-item-product-linkage";
import { applyReturnItemProductEnrichmentAfterInsert } from "@/lib/scanner/apply-return-item-product-enrichment";
import { updateRowWithScannerLinkagePatch } from "@/lib/scanner/scanner-linkage-patch";

export type OperatorStoreScopeSnapshot = {
  stores: OperatorStoreOption[];
  defaultStoreId: string | null;
};

function normalizeStoreRow(raw: unknown): OperatorStoreOption | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { id?: unknown; name?: unknown; platform?: unknown };
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!isUuidString(id)) return null;
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "Store";
  const platform = typeof row.platform === "string" && row.platform.trim() ? row.platform.trim() : "unknown";
  return { id, name, platform };
}

/**
 * Server-side store scope resolver for operator scanner.
 * Uses service-role reads with explicit actor checks so super_admin workspace switch
 * can load selected org stores without being blocked by browser RLS policies.
 */
export async function getOperatorStoreScopeForOrganization(
  requestedOrganizationId: string | null | undefined,
): Promise<{ ok: true; snapshot: OperatorStoreScopeSnapshot } | { ok: false; error: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }
  const profile = await loadTenantProfile(sessionUserId);
  if (!profile) {
    return { ok: false, error: "Profile not found." };
  }

  const req = String(requestedOrganizationId ?? "").trim();
  const reqOk = req && isUuidString(req) ? req : null;
  const canSwitchOrg = canPickWorkspaceOrganizationForTenantBranding(profile.role);
  const orgId = canSwitchOrg ? (reqOk ?? profile.organization_id) : profile.organization_id;

  const [storesRes, settingsRes] = await Promise.all([
    supabaseServer
      .from("stores")
      .select("id,name,platform")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .order("name", { ascending: true }),
    supabaseServer
      .from("organization_settings")
      .select("default_store_id")
      .eq("organization_id", orgId)
      .maybeSingle(),
  ]);

  if (storesRes.error) {
    return { ok: false, error: storesRes.error.message };
  }
  if (settingsRes.error) {
    return { ok: false, error: settingsRes.error.message };
  }

  const stores = (storesRes.data ?? [])
    .map(normalizeStoreRow)
    .filter((r): r is OperatorStoreOption => Boolean(r));
  const rawDefault = typeof settingsRes.data?.default_store_id === "string"
    ? settingsRes.data.default_store_id.trim()
    : "";
  const defaultStoreId = rawDefault && isUuidString(rawDefault) ? rawDefault : null;

  return {
    ok: true,
    snapshot: {
      stores,
      defaultStoreId,
    },
  };
}

export type OperatorPackageListRow = {
  id: string;
  package_code: string | null;
  tracking_number: string | null;
  /** Marketplace / removal order id stored on the package row. */
  order_id?: string | null;
  id_slip_contents: string | null;
  notes?: string | null;
  outside_photo_urls?: unknown;
  inside_photo_urls?: unknown;
  slip_photo_urls?: unknown;
  expected_item_count?: number | null;
  actual_item_count?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  /** Filled by {@link listOperatorPackagesForPalletAction} via profiles lookup. */
  created_by_display?: string | null;
  updated_by_display?: string | null;
  /** Number of distinct packing-slip lines (SKUs) for this package — filled by {@link listOperatorPackagesForPalletAction}. */
  slip_line_count?: number | null;
  /** Item-scan receive lock — read from `packages.manifest_data` for picker UI only. */
  manifest_data?: unknown;
};

async function enrichOperatorPackageItemRowsWithAuditLabels(
  rows: OperatorPackageItemRow[],
): Promise<OperatorPackageItemRow[]> {
  const labelById = await resolveDisplayLabelsForUserIds(
    rows.flatMap((r) => [r.created_by, r.updated_by]),
  );
  return rows.map((r) => {
    const cb = String(r.created_by ?? "").trim();
    const ub = String(r.updated_by ?? "").trim();
    const created_by_display = isUuidString(cb)
      ? (labelById.get(cb) ?? null)
      : cb
        ? cb
        : null;
    const updated_by_display = isUuidString(ub)
      ? (labelById.get(ub) ?? null)
      : ub
        ? ub
        : null;
    return { ...r, created_by_display, updated_by_display };
  });
}

async function enrichOperatorPackageRowsWithProfileLabels(
  rows: OperatorPackageListRow[],
): Promise<OperatorPackageListRow[]> {
  const ids = new Set<string>();
  for (const r of rows) {
    const cb = String(r.created_by ?? "").trim();
    const ub = String(r.updated_by ?? "").trim();
    if (isUuidString(cb)) ids.add(cb);
    if (isUuidString(ub)) ids.add(ub);
  }
  if (ids.size === 0) {
    return rows.map((r) => ({
      ...r,
      created_by_display: null,
      updated_by_display: null,
    }));
  }
  const idList = [...ids];
  const { data: profs, error } = await supabaseServer.from("profiles").select("id, full_name").in("id", idList);
  if (error) {
    console.warn("[enrichOperatorPackageRowsWithProfileLabels]", error.message);
    return rows.map((r) => ({
      ...r,
      created_by_display: null,
      updated_by_display: null,
    }));
  }
  const labelById = new Map<string, string>();
  for (const pr of profs ?? []) {
    const raw = pr as { id?: string; full_name?: string | null };
    const id = String(raw.id ?? "").trim();
    if (!isUuidString(id)) continue;
    const fn = String(raw.full_name ?? "").trim();
    labelById.set(id, fn || "Unknown");
  }
  return rows.map((r) => {
    const cb = String(r.created_by ?? "").trim();
    const ub = String(r.updated_by ?? "").trim();
    return {
      ...r,
      created_by_display: isUuidString(cb) ? (labelById.get(cb) ?? null) : null,
      updated_by_display: isUuidString(ub) ? (labelById.get(ub) ?? null) : null,
    };
  });
}

/**
 * BOX collaboration: list active packages on a pallet (service role + org resolution).
 * Scoped to `storeId` when provided so operators only see packages for the active store.
 */
export async function listOperatorPackagesForPalletAction(
  requestedOrganizationId: string,
  palletId: string,
  storeId?: string | null,
): Promise<{ ok: true; packages: OperatorPackageListRow[] } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const pid = String(palletId ?? "").trim();
  if (!isUuidString(pid)) {
    return { ok: false, message: "Invalid pallet id." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const { data: pchk, error: perr } = await supabaseServer
    .from("pallets")
    .select("id, store_id")
    .eq("id", pid)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (perr) return { ok: false, message: perr.message };
  if (!pchk) {
    return { ok: false, message: "Pallet not found for this organization." };
  }
  const storeScope = String(storeId ?? "").trim();
  const palletStore = String((pchk as { store_id?: string | null }).store_id ?? "").trim();
  if (storeScope && isUuidString(storeScope) && palletStore && isUuidString(palletStore) && palletStore !== storeScope) {
    return { ok: false, message: "This pallet belongs to another store — select the correct store." };
  }
  let pkgQuery = supabaseServer
    .from("packages")
    .select(
      // `notes` = packages.notes (plural). Do not use legacy discrepancy_note / operator_note column names.
      "id, package_code, tracking_number, order_id, id_slip_contents, notes, outside_photo_urls, inside_photo_urls, slip_photo_urls, expected_item_count, actual_item_count, manifest_data, created_at, updated_at, created_by, updated_by",
    )
    .eq("organization_id", organizationId)
    .eq("pallet_id", pid)
    .is("deleted_at", null);
  if (storeScope && isUuidString(storeScope)) {
    pkgQuery = pkgQuery.eq("store_id", storeScope);
  }
  const { data, error } = await pkgQuery.order("updated_at", { ascending: false });
  if (error) return { ok: false, message: error.message };
  const rawRows = (data ?? []) as OperatorPackageListRow[];
  const packages = await enrichOperatorPackageRowsWithProfileLabels(rawRows);

  // Enrich with slip_contents count (distinct packing-slip lines per package)
  if (packages.length > 0) {
    try {
      const pkgIds = packages.map((p) => p.id).filter(Boolean);
      const { data: slipCounts } = await supabaseServer
        .from("slip_contents")
        .select("package_id")
        .in("package_id", pkgIds)
        .is("deleted_at", null);
      if (slipCounts) {
        const countByPkg = new Map<string, number>();
        for (const row of slipCounts) {
          const pid2 = String(row.package_id ?? "").trim();
          if (pid2) countByPkg.set(pid2, (countByPkg.get(pid2) ?? 0) + 1);
        }
        for (const pkg of packages) {
          (pkg as OperatorPackageListRow).slip_line_count = countByPkg.get(pkg.id) ?? 0;
        }
      }
    } catch {
      /* slip_line_count stays undefined — non-fatal */
    }
  }

  return { ok: true, packages };
}

const OPERATOR_PALLET_HYDRATION_SELECT =
  "carrier_name, order_id, notes, shipping_label_urls, pallet_photo_urls, bol_photo_urls, created_by, created_at, updated_at, store_id";

/** Row returned by {@link fetchOperatorPalletHydrationAction} — mirrors client pallet hydrate column list. */
export type OperatorPalletHydrationRow = {
  carrier_name?: string | null;
  order_id?: string | null;
  notes?: string | null;
  shipping_label_urls?: unknown;
  pallet_photo_urls?: unknown;
  bol_photo_urls?: unknown;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  store_id?: string | null;
};

/**
 * Service-role pallet row for operator UI hydrate (browser RLS often hides `pallets.order_id`).
 * Validates org and optional active-store scope like {@link listOperatorPackagesForPalletAction}.
 */
export async function fetchOperatorPalletHydrationAction(
  requestedOrganizationId: string,
  palletId: string,
  storeId?: string | null,
): Promise<
  | { ok: true; row: OperatorPalletHydrationRow }
  | { ok: false; message: string; wrongStore?: boolean }
> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const pid = String(palletId ?? "").trim();
  if (!isUuidString(pid)) {
    return { ok: false, message: "Invalid pallet id." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const { data, error } = await supabaseServer
    .from("pallets")
    .select(OPERATOR_PALLET_HYDRATION_SELECT)
    .eq("id", pid)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  if (!data) {
    return { ok: false, message: "Pallet not found for this organization." };
  }
  const storeScope = String(storeId ?? "").trim();
  const rowStore = String((data as { store_id?: string | null }).store_id ?? "").trim();
  if (
    storeScope &&
    isUuidString(storeScope) &&
    rowStore &&
    isUuidString(rowStore) &&
    rowStore !== storeScope
  ) {
    return {
      ok: false,
      message: "This pallet belongs to another store — select the correct store.",
      wrongStore: true,
    };
  }
  return { ok: true, row: data as OperatorPalletHydrationRow };
}

function isMissingSlipContentsConflictingOrderIdSchemaError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    m.includes("slip_contents") &&
    m.includes("conflicting_order_id") &&
    (m.includes("schema cache") || m.includes("could not find") || m.includes("column"))
  );
}

function isMissingSlipContentsOrderIdSchemaError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    m.includes("slip_contents") &&
    m.includes("order_id") &&
    !m.includes("conflicting_order_id") &&
    (m.includes("schema cache") || m.includes("could not find") || m.includes("column"))
  );
}

function isMissingSlipContentsParsedIdentifierSchemaError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    m.includes("slip_contents") &&
    (m.includes("parsed_asin") || m.includes("parsed_fnsku") || m.includes("parsed_upc")) &&
    (m.includes("schema cache") || m.includes("could not find") || m.includes("column") || m.includes("42703"))
  );
}

/** Row shape for hydrating BOX slip lines (matches `slip_contents` + client `mapSlipContentRowToVisionLine`). */
export type OperatorSlipContentsListRow = {
  /** `slip_contents.id` when loaded from DB — stable key for UI. */
  id: string | null;
  upc: string | null;
  fnsku: string | null;
  description: string | null;
  quantity: number;
  condition: string | null;
  /** Line-level JSON flags (e.g. `{ "missing": true }`) — not operator prose. */
  notes?: string | null;
  rma_number: string | null;
  sort_index: number;
  slip_code: string | null;
  /** Slip-derived token (`slip_contents.order_id`). */
  order_id?: string | null;
  /** When slip token disagreed with pallet at save: parent pallet `order_id` (differs from {@link order_id}). Otherwise null. */
  conflicting_order_id?: string | null;
  /** Server-built product linkage display (PRODUCT-API contract). */
  product_linkage: ProductLinkageDisplayContract;
};

/**
 * Load `slip_contents` lines for a package (service role + org check).
 * Use this from the operator scan UI instead of browser Supabase, which may be blocked by RLS.
 */
export async function listOperatorSlipContentsForPackageAction(
  requestedOrganizationId: string,
  packageId: string,
  storeId?: string | null,
): Promise<{ ok: true; rows: OperatorSlipContentsListRow[] } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const pkgId = String(packageId ?? "").trim();
  if (!isUuidString(pkgId)) {
    return { ok: false, message: "Invalid package id." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const { data: pkgRow, error: pkgSelErr } = await supabaseServer
    .from("packages")
    .select("id, store_id")
    .eq("id", pkgId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgSelErr) return { ok: false, message: pkgSelErr.message };
  if (!pkgRow) {
    return { ok: false, message: "Package not found for this organization." };
  }
  const scope = String(storeId ?? "").trim();
  const pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  if (scope && isUuidString(scope) && pkgStore && isUuidString(pkgStore) && pkgStore !== scope) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  const slipSelectAttempts = [
    "id, upc, fnsku, parsed_fnsku, parsed_upc, description, quantity, condition, rma_number, sort_index, slip_code, order_id, conflicting_order_id, resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence",
    "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, order_id, conflicting_order_id",
    "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, conflicting_order_id",
    "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, order_id",
    "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code",
  ];

  let slipRes: {
    data: unknown;
    error: { message: string } | null;
  } | null = null;
  for (const sel of slipSelectAttempts) {
    const r = await supabaseServer
      .from("slip_contents")
      .select(sel)
      .eq("package_id", pkgId)
      .order("sort_index", { ascending: true });
    slipRes = r;
    if (!r.error) break;
  }
  if (!slipRes || slipRes.error) {
    return { ok: false, message: slipRes?.error?.message ?? "slip_contents load failed." };
  }
  const rowsRaw = slipRes.data;
  const rows = Array.isArray(rowsRaw) ? rowsRaw : [];

  const linkageStubs = rows.map((raw: unknown) => {
    const r = raw as Record<string, unknown>;
    const q = Number(r.quantity ?? 0);
    const idRaw = typeof r.id === "string" ? r.id.trim() : "";
    return {
      id: idRaw && isUuidString(idRaw) ? idRaw : null,
      upc: typeof r.upc === "string" && r.upc.trim() ? r.upc.trim() : null,
      fnsku:
        coalesceSlipRowFnsku({
          fnsku: typeof r.fnsku === "string" ? r.fnsku : null,
          parsed_fnsku: typeof r.parsed_fnsku === "string" ? r.parsed_fnsku : null,
        }),
      description: typeof r.description === "string" && r.description.trim() ? r.description.trim() : null,
      quantity: Number.isFinite(q) && q >= 0 ? Math.floor(q) : 0,
      condition: typeof r.condition === "string" && r.condition.trim() ? r.condition.trim() : null,
      notes: typeof r.notes === "string" && r.notes.trim() ? r.notes.trim() : null,
      rma_number: typeof r.rma_number === "string" && r.rma_number.trim() ? r.rma_number.trim() : null,
      sort_index: Number.isFinite(Number(r.sort_index)) ? Math.floor(Number(r.sort_index)) : 0,
      slip_code: typeof r.slip_code === "string" && r.slip_code.trim() ? r.slip_code.trim() : null,
      order_id:
        typeof r.order_id === "string" && r.order_id.trim() ? r.order_id.trim() : null,
      conflicting_order_id:
        typeof r.conflicting_order_id === "string" && r.conflicting_order_id.trim()
          ? r.conflicting_order_id.trim()
          : null,
      resolved_product_id:
        typeof r.resolved_product_id === "string" && isUuidString(r.resolved_product_id.trim())
          ? r.resolved_product_id.trim()
          : null,
      identifier_resolution_status:
        typeof r.identifier_resolution_status === "string" ? r.identifier_resolution_status : null,
      identifier_resolution_confidence: (() => {
        const n = Number(r.identifier_resolution_confidence);
        return Number.isFinite(n) ? n : null;
      })(),
    };
  });

  const productIds = linkageStubs
    .map((s) => s.resolved_product_id)
    .filter((id): id is string => Boolean(id));
  const productNameById = await fetchProductNamesByResolvedIds(
    supabaseServer as unknown as ProductsLookupClient,
    productIds,
  );

  const normalized: OperatorSlipContentsListRow[] = linkageStubs.map((stub) => {
    const { resolved_product_id, identifier_resolution_status, identifier_resolution_confidence, ...rest } = stub;
    return {
      ...rest,
      product_linkage: buildProductLinkageDisplayContract(
        {
          resolved_product_id,
          identifier_resolution_status,
          identifier_resolution_confidence,
          description: stub.description,
          fnsku: stub.fnsku,
          upc: stub.upc,
        },
        productNameById,
      ),
    };
  });

  return { ok: true, rows: normalized };
}

/** Phase 6F-B — read-only slip vs shipment vs scan validation preview (no writes). */
export async function computeSlipShipmentValidationPreviewAction(
  requestedOrganizationId: string,
  packageId: string,
): Promise<{ ok: true; preview: SlipShipmentValidationPreview } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const pkgId = String(packageId ?? "").trim();
  if (!isUuidString(pkgId)) {
    return { ok: false, message: "Invalid package id." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const preview = await buildSlipShipmentValidationPreview(supabaseServer, organizationId, pkgId);
  if ("error" in preview) {
    return { ok: false, message: preview.error };
  }
  return { ok: true, preview };
}

/** Phase 6E-A — read-only pallet/shipment review preview (no close, no claims). */
export async function computePalletShipmentReviewPreviewAction(
  requestedOrganizationId: string,
  input: {
    storeId: string;
    palletId?: string | null;
    trackingNumber?: string | null;
  },
): Promise<{ ok: true; preview: PalletShipmentReviewPreview } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, message: "Invalid store id." };
  }
  const palletId = String(input.palletId ?? "").trim() || null;
  const trackingNumber = String(input.trackingNumber ?? "").trim() || null;
  if (!palletId && !trackingNumber) {
    return { ok: false, message: "Provide palletId or trackingNumber." };
  }

  const preview = await buildPalletShipmentReviewPreview(supabaseServer, {
    organizationId,
    storeId,
    palletId,
    trackingNumber,
  });
  if ("error" in preview) {
    return { ok: false, message: preview.error };
  }
  return { ok: true, preview };
}

async function insertOperatorPalletAuditLog(args: {
  organizationId: string;
  palletId: string;
  action: string;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  actor: string;
}): Promise<void> {
  await supabaseServer.from("pallet_audit_log").insert({
    organization_id: args.organizationId,
    pallet_id: args.palletId,
    action: args.action,
    field: args.field ?? null,
    old_value: args.oldValue ?? null,
    new_value: args.newValue ?? null,
    actor: args.actor,
  });
}

export type OperatorPalletCloseState = {
  close_state: "open" | "finalized";
  status: string | null;
  review_snapshot: PalletCloseReviewSnapshot | null;
};

/** Read pallet close state from status + photo_evidence manifest (no writes). */
export async function getOperatorPalletCloseStateAction(
  requestedOrganizationId: string,
  palletId: string,
): Promise<{ ok: true; state: OperatorPalletCloseState } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const pid = String(palletId ?? "").trim();
  if (!isUuidString(pid)) {
    return { ok: false, message: "Invalid pallet id." };
  }

  const { data, error } = await supabaseServer
    .from("pallets")
    .select("id, status, photo_evidence")
    .eq("id", pid)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: false, message: "Pallet not found for this organization." };

  const row = data as { status?: string | null; photo_evidence?: unknown };
  const read = readPalletCloseState(row.photo_evidence, row.status);
  return {
    ok: true,
    state: {
      close_state: read.close_state,
      status: row.status ?? null,
      review_snapshot: read.manifest?.review_confirmed ?? null,
    },
  };
}

export type FinalizeOperatorPalletCloseInput = {
  requestedOrganizationId: string;
  storeId: string;
  palletId: string;
  reviewSnapshot: PalletCloseReviewSnapshot;
};

export type FinalizeOperatorPalletCloseResult =
  | { ok: true; status: "closed"; close_state: "finalized" }
  | { ok: false; message: string };

/**
 * Phase 6D — Pallet close: review snapshot on manifest + status closed.
 * Does not create claim_cases or claim_candidates.
 */
export async function finalizeOperatorPalletCloseAction(
  input: FinalizeOperatorPalletCloseInput,
): Promise<FinalizeOperatorPalletCloseResult> {
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const gate = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_CLOSE_PALLET);
  if (!gate.ok) return { ok: false, message: gate.message };

  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, message: "Invalid store id." };
  }
  const palletId = String(input.palletId ?? "").trim();
  if (!isUuidString(palletId)) {
    return { ok: false, message: "Invalid pallet id." };
  }

  const preview = await buildPalletShipmentReviewPreview(supabaseServer, {
    organizationId,
    storeId,
    palletId,
  });
  if ("error" in preview) {
    return { ok: false, message: preview.error };
  }
  void buildPalletCloseReviewModelFromPreview(preview);

  const { data: row, error: selErr } = await supabaseServer
    .from("pallets")
    .select("id, organization_id, store_id, status, photo_evidence")
    .eq("id", palletId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (selErr) return { ok: false, message: selErr.message };
  if (!row) return { ok: false, message: "Pallet not found for this organization." };

  const palletStore = String((row as { store_id?: string | null }).store_id ?? "").trim();
  if (palletStore && isUuidString(palletStore) && palletStore !== storeId) {
    return { ok: false, message: "This pallet belongs to another store." };
  }

  const statusNorm = String((row as { status?: string | null }).status ?? "").trim().toLowerCase();
  if (statusNorm === "closed" || statusNorm === "submitted") {
    return { ok: false, message: "Pallet is already closed." };
  }

  const now = new Date().toISOString();
  const actor = await resolveAuditActorForSession();
  const prior = readPalletCloseState((row as { photo_evidence?: unknown }).photo_evidence, statusNorm);
  const photo_evidence = mergePalletPhotoEvidenceFinalize((row as { photo_evidence?: unknown }).photo_evidence, {
    finalizedAtIso: now,
    finalizedBy: gate.userId,
    reviewSnapshot: input.reviewSnapshot,
    priorRevision: prior.manifest?.close_revision,
  });

  const patch: Record<string, unknown> = {
    status: "closed",
    photo_evidence,
    updated_at: now,
  };
  if (actor.userId && isUuidString(actor.userId)) patch.updated_by = actor.userId;

  const { error: updErr } = await supabaseServer
    .from("pallets")
    .update(patch)
    .eq("id", palletId)
    .eq("organization_id", organizationId);
  if (updErr) return { ok: false, message: updErr.message };

  await insertOperatorPalletAuditLog({
    organizationId,
    palletId,
    action: "pallet_close",
    field: "status",
    oldValue: statusNorm || "open",
    newValue: JSON.stringify({
      status: "closed",
      review_bucket_counts: input.reviewSnapshot.bucket_counts,
      totals: input.reviewSnapshot.totals,
      critical_issues_acknowledged: input.reviewSnapshot.critical_issues_acknowledged,
    }).slice(0, 4000),
    actor: actor.displayName || gate.userId,
  });

  return { ok: true, status: "closed", close_state: "finalized" };
}

export type ReopenOperatorPalletCloseInput = {
  requestedOrganizationId: string;
  palletId: string;
  reason?: string | null;
};

/** Permission-gated pallet reopen — restores edit capability; audit logged. No claims. */
export async function reopenOperatorPalletCloseAction(
  input: ReopenOperatorPalletCloseInput,
): Promise<{ ok: true; close_state: "open"; status: "open" } | { ok: false; message: string }> {
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const gate = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_REOPEN_PALLET);
  if (!gate.ok) return { ok: false, message: gate.message };

  const palletId = String(input.palletId ?? "").trim();
  if (!isUuidString(palletId)) {
    return { ok: false, message: "Invalid pallet id." };
  }

  const { data: row, error: selErr } = await supabaseServer
    .from("pallets")
    .select("id, status, photo_evidence")
    .eq("id", palletId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (selErr) return { ok: false, message: selErr.message };
  if (!row) return { ok: false, message: "Pallet not found for this organization." };

  const statusNorm = String((row as { status?: string | null }).status ?? "").trim().toLowerCase();
  const read = readPalletCloseState((row as { photo_evidence?: unknown }).photo_evidence, statusNorm);
  if (read.close_state !== "finalized" && statusNorm !== "closed" && statusNorm !== "submitted") {
    return { ok: false, message: "Pallet is not closed." };
  }

  const now = new Date().toISOString();
  const actor = await resolveAuditActorForSession();
  const photo_evidence = mergePalletPhotoEvidenceReopen((row as { photo_evidence?: unknown }).photo_evidence, {
    reopenedAtIso: now,
    reopenedBy: gate.userId,
  });

  const patch: Record<string, unknown> = {
    status: "open",
    photo_evidence,
    updated_at: now,
  };
  if (actor.userId && isUuidString(actor.userId)) patch.updated_by = actor.userId;

  const { error: updErr } = await supabaseServer
    .from("pallets")
    .update(patch)
    .eq("id", palletId)
    .eq("organization_id", organizationId);
  if (updErr) return { ok: false, message: updErr.message };

  const reason = String(input.reason ?? "").trim();
  await insertOperatorPalletAuditLog({
    organizationId,
    palletId,
    action: "pallet_reopen",
    field: "status",
    oldValue: statusNorm || "closed",
    newValue: reason || "open",
    actor: actor.displayName || gate.userId,
  });

  return { ok: true, close_state: "open", status: "open" };
}

type ShipmentCloseAnchor =
  | { kind: "pallet"; palletId: string; packageId: string | null }
  | { kind: "package"; palletId: null; packageId: string };

async function resolveShipmentCloseAnchor(
  organizationId: string,
  storeId: string,
  trackingNumber: string,
  preferredPalletId?: string | null,
): Promise<{ ok: true; anchor: ShipmentCloseAnchor } | { ok: false; message: string }> {
  const tn = String(trackingNumber ?? "").trim();
  if (!tn) return { ok: false, message: "Tracking number is required." };

  const { data, error } = await supabaseServer
    .from("packages")
    .select("id, pallet_id, created_at")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("tracking_number", tn)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, message: error.message };

  const rows = (data ?? []) as { id?: string; pallet_id?: string | null }[];
  if (rows.length === 0) {
    return { ok: false, message: "No boxes found for this shipment tracking number." };
  }

  const preferred = String(preferredPalletId ?? "").trim();
  const palletCounts = new Map<string, number>();
  for (const row of rows) {
    const pid = String(row.pallet_id ?? "").trim();
    if (pid && isUuidString(pid)) {
      palletCounts.set(pid, (palletCounts.get(pid) ?? 0) + 1);
    }
  }

  let chosenPallet: string | null = null;
  if (preferred && isUuidString(preferred) && palletCounts.has(preferred)) {
    chosenPallet = preferred;
  } else if (palletCounts.size > 0) {
    chosenPallet = [...palletCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  const firstPackageId = String(rows[0]?.id ?? "").trim();
  if (chosenPallet && isUuidString(chosenPallet)) {
    const pkgOnPallet =
      rows.find((r) => String(r.pallet_id ?? "").trim() === chosenPallet)?.id ?? firstPackageId;
    return {
      ok: true,
      anchor: {
        kind: "pallet",
        palletId: chosenPallet,
        packageId: isUuidString(String(pkgOnPallet ?? "")) ? String(pkgOnPallet) : null,
      },
    };
  }

  if (!isUuidString(firstPackageId)) {
    return { ok: false, message: "Could not resolve anchor package for shipment close." };
  }
  return { ok: true, anchor: { kind: "package", palletId: null, packageId: firstPackageId } };
}

async function readShipmentCloseStateForTracking(
  organizationId: string,
  storeId: string,
  trackingNumber: string,
  preferredPalletId?: string | null,
): Promise<
  | {
      ok: true;
      close_state: "open" | "finalized";
      review_snapshot: ShipmentCloseReviewSnapshot | null;
      anchor: ShipmentCloseAnchor;
    }
  | { ok: false; message: string }
> {
  const anchorRes = await resolveShipmentCloseAnchor(
    organizationId,
    storeId,
    trackingNumber,
    preferredPalletId,
  );
  if (!anchorRes.ok) return anchorRes;

  const { anchor } = anchorRes;
  if (anchor.kind === "pallet") {
    const { data, error } = await supabaseServer
      .from("pallets")
      .select("photo_evidence")
      .eq("id", anchor.palletId)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) return { ok: false, message: error.message };
    const read = readShipmentCloseFromPalletPhotoEvidence(
      (data as { photo_evidence?: unknown } | null)?.photo_evidence,
      trackingNumber,
    );
    return {
      ok: true,
      close_state: read.close_state,
      review_snapshot: read.manifest?.review_confirmed ?? null,
      anchor,
    };
  }

  const { data, error } = await supabaseServer
    .from("packages")
    .select("manifest_data")
    .eq("id", anchor.packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  const read = readShipmentCloseFromPackageManifest(
    (data as { manifest_data?: unknown } | null)?.manifest_data,
    trackingNumber,
  );
  return {
    ok: true,
    close_state: read.close_state,
    review_snapshot: read.manifest?.review_confirmed ?? null,
    anchor,
  };
}

async function insertOperatorPackageAuditLog(args: {
  organizationId: string;
  packageId: string;
  action: string;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  actor: string;
}): Promise<void> {
  await supabaseServer.from("package_audit_log").insert({
    organization_id: args.organizationId,
    package_id: args.packageId,
    action: args.action,
    field: args.field ?? null,
    old_value: args.oldValue ?? null,
    new_value: args.newValue ?? null,
    actor: args.actor,
  });
}

export type OperatorShipmentCloseState = {
  close_state: "open" | "finalized";
  tracking_number: string;
  review_snapshot: ShipmentCloseReviewSnapshot | null;
  storage_kind: "pallet_photo_evidence" | "package_manifest_data" | null;
};

/** Read shipment close state from pallet photo_evidence or anchor package manifest_data. */
export async function getOperatorShipmentCloseStateAction(
  requestedOrganizationId: string,
  input: {
    storeId: string;
    trackingNumber: string;
    preferredPalletId?: string | null;
  },
): Promise<{ ok: true; state: OperatorShipmentCloseState } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, message: "Invalid store id." };
  }
  const trackingNumber = String(input.trackingNumber ?? "").trim();
  if (!trackingNumber) {
    return { ok: false, message: "Tracking number is required." };
  }

  const read = await readShipmentCloseStateForTracking(
    organizationId,
    storeId,
    trackingNumber,
    input.preferredPalletId,
  );
  if (!read.ok) return read;

  return {
    ok: true,
    state: {
      close_state: read.close_state,
      tracking_number: trackingNumber,
      review_snapshot: read.review_snapshot,
      storage_kind:
        read.anchor.kind === "pallet" ? "pallet_photo_evidence" : "package_manifest_data",
    },
  };
}

export type FinalizeOperatorShipmentCloseInput = {
  requestedOrganizationId: string;
  storeId: string;
  trackingNumber: string;
  preferredPalletId?: string | null;
  reviewSnapshot: ShipmentCloseReviewSnapshot;
};

/**
 * Phase 6E — Shipment close: unified review engine shipment scope + audit snapshot.
 * Does not create claim_cases, claim_candidates, or missing return_items.
 */
export async function finalizeOperatorShipmentCloseAction(
  input: FinalizeOperatorShipmentCloseInput,
): Promise<
  { ok: true; close_state: "finalized"; storage_kind: "pallet_photo_evidence" | "package_manifest_data" } | { ok: false; message: string }
> {
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const gate = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_CLOSE_SHIPMENT_REVIEW);
  if (!gate.ok) return { ok: false, message: gate.message };

  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, message: "Invalid store id." };
  }
  const trackingNumber = String(input.trackingNumber ?? "").trim();
  if (!trackingNumber) {
    return { ok: false, message: "Tracking number is required." };
  }

  const existing = await readShipmentCloseStateForTracking(
    organizationId,
    storeId,
    trackingNumber,
    input.preferredPalletId,
  );
  if (!existing.ok) return existing;
  if (existing.close_state === "finalized") {
    return { ok: false, message: "Shipment warehouse receive review is already closed." };
  }

  const preview = await buildPalletShipmentReviewPreview(supabaseServer, {
    organizationId,
    storeId,
    trackingNumber,
  });
  if ("error" in preview) {
    return { ok: false, message: preview.error };
  }
  if (preview.scope_kind !== "shipment_tracking") {
    return { ok: false, message: "Shipment review preview must use shipment tracking scope." };
  }
  void buildShipmentCloseReviewModelFromPreview(preview);

  const now = new Date().toISOString();
  const actor = await resolveAuditActorForSession();
  const { anchor } = existing;

  if (anchor.kind === "pallet") {
    const { data: row, error: selErr } = await supabaseServer
      .from("pallets")
      .select("id, photo_evidence")
      .eq("id", anchor.palletId)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (selErr) return { ok: false, message: selErr.message };
    if (!row) return { ok: false, message: "Anchor pallet not found." };

    const prior = readShipmentCloseFromPalletPhotoEvidence(
      (row as { photo_evidence?: unknown }).photo_evidence,
      trackingNumber,
    );
    const photo_evidence = mergePalletPhotoEvidenceShipmentCloseFinalize(
      (row as { photo_evidence?: unknown }).photo_evidence,
      {
        trackingNumber,
        storeId,
        anchorPalletId: anchor.palletId,
        anchorPackageId: anchor.packageId,
        finalizedAtIso: now,
        finalizedBy: gate.userId,
        reviewSnapshot: input.reviewSnapshot,
        priorRevision: prior.manifest?.close_revision,
      },
    );

    const patch: Record<string, unknown> = { photo_evidence, updated_at: now };
    if (actor.userId && isUuidString(actor.userId)) patch.updated_by = actor.userId;

    const { error: updErr } = await supabaseServer
      .from("pallets")
      .update(patch)
      .eq("id", anchor.palletId)
      .eq("organization_id", organizationId);
    if (updErr) return { ok: false, message: updErr.message };

    await insertOperatorPalletAuditLog({
      organizationId,
      palletId: anchor.palletId,
      action: "shipment_receive_close",
      field: "operator_shipment_receive_close",
      oldValue: "open",
      newValue: JSON.stringify({
        tracking_number: trackingNumber,
        review_bucket_counts: input.reviewSnapshot.bucket_counts,
        totals: input.reviewSnapshot.totals,
        critical_issues_acknowledged: input.reviewSnapshot.critical_issues_acknowledged,
      }).slice(0, 4000),
      actor: actor.displayName || gate.userId,
    });

    return { ok: true, close_state: "finalized", storage_kind: "pallet_photo_evidence" };
  }

  const { data: pkgRow, error: pkgSelErr } = await supabaseServer
    .from("packages")
    .select("id, manifest_data")
    .eq("id", anchor.packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgSelErr) return { ok: false, message: pkgSelErr.message };
  if (!pkgRow) return { ok: false, message: "Anchor package not found." };

  const prior = readShipmentCloseFromPackageManifest(
    (pkgRow as { manifest_data?: unknown }).manifest_data,
    trackingNumber,
  );
  const manifest_data = mergePackageManifestShipmentCloseFinalize(
    (pkgRow as { manifest_data?: unknown }).manifest_data,
    {
      trackingNumber,
      storeId,
      anchorPackageId: anchor.packageId,
      finalizedAtIso: now,
      finalizedBy: gate.userId,
      reviewSnapshot: input.reviewSnapshot,
      priorRevision: prior.manifest?.close_revision,
    },
  );

  const patch: Record<string, unknown> = { manifest_data, updated_at: now };
  if (actor.userId && isUuidString(actor.userId)) patch.updated_by = actor.userId;

  const { error: pkgUpdErr } = await supabaseServer
    .from("packages")
    .update(patch)
    .eq("id", anchor.packageId)
    .eq("organization_id", organizationId);
  if (pkgUpdErr) return { ok: false, message: pkgUpdErr.message };

  await insertOperatorPackageAuditLog({
    organizationId,
    packageId: anchor.packageId,
    action: "shipment_receive_close",
    field: "operator_shipment_receive_close",
    oldValue: "open",
    newValue: JSON.stringify({
      tracking_number: trackingNumber,
      review_bucket_counts: input.reviewSnapshot.bucket_counts,
      totals: input.reviewSnapshot.totals,
      critical_issues_acknowledged: input.reviewSnapshot.critical_issues_acknowledged,
    }).slice(0, 4000),
    actor: actor.displayName || gate.userId,
  });

  return { ok: true, close_state: "finalized", storage_kind: "package_manifest_data" };
}

export type ReopenOperatorShipmentCloseInput = {
  requestedOrganizationId: string;
  storeId: string;
  trackingNumber: string;
  preferredPalletId?: string | null;
  reason?: string | null;
};

/** Permission-gated shipment reopen — restores edit capability; audit logged. No claims. */
export async function reopenOperatorShipmentCloseAction(
  input: ReopenOperatorShipmentCloseInput,
): Promise<
  { ok: true; close_state: "open"; storage_kind: "pallet_photo_evidence" | "package_manifest_data" } | { ok: false; message: string }
> {
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const gate = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW);
  if (!gate.ok) return { ok: false, message: gate.message };

  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, message: "Invalid store id." };
  }
  const trackingNumber = String(input.trackingNumber ?? "").trim();
  if (!trackingNumber) {
    return { ok: false, message: "Tracking number is required." };
  }

  const existing = await readShipmentCloseStateForTracking(
    organizationId,
    storeId,
    trackingNumber,
    input.preferredPalletId,
  );
  if (!existing.ok) return existing;
  if (existing.close_state !== "finalized") {
    return { ok: false, message: "Shipment warehouse receive review is not closed." };
  }

  const now = new Date().toISOString();
  const actor = await resolveAuditActorForSession();
  const { anchor } = existing;
  const reason = String(input.reason ?? "").trim();

  if (anchor.kind === "pallet") {
    const { data: row, error: selErr } = await supabaseServer
      .from("pallets")
      .select("id, photo_evidence")
      .eq("id", anchor.palletId)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (selErr) return { ok: false, message: selErr.message };
    if (!row) return { ok: false, message: "Anchor pallet not found." };

    const photo_evidence = mergePalletPhotoEvidenceShipmentCloseReopen(
      (row as { photo_evidence?: unknown }).photo_evidence,
      { reopenedAtIso: now, reopenedBy: gate.userId },
    );
    const patch: Record<string, unknown> = { photo_evidence, updated_at: now };
    if (actor.userId && isUuidString(actor.userId)) patch.updated_by = actor.userId;

    const { error: updErr } = await supabaseServer
      .from("pallets")
      .update(patch)
      .eq("id", anchor.palletId)
      .eq("organization_id", organizationId);
    if (updErr) return { ok: false, message: updErr.message };

    await insertOperatorPalletAuditLog({
      organizationId,
      palletId: anchor.palletId,
      action: "shipment_receive_reopen",
      field: "operator_shipment_receive_close",
      oldValue: "finalized",
      newValue: reason || "open",
      actor: actor.displayName || gate.userId,
    });

    return { ok: true, close_state: "open", storage_kind: "pallet_photo_evidence" };
  }

  const { data: pkgRow, error: pkgSelErr } = await supabaseServer
    .from("packages")
    .select("id, manifest_data")
    .eq("id", anchor.packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgSelErr) return { ok: false, message: pkgSelErr.message };
  if (!pkgRow) return { ok: false, message: "Anchor package not found." };

  const manifest_data = mergePackageManifestShipmentCloseReopen(
    (pkgRow as { manifest_data?: unknown }).manifest_data,
    { reopenedAtIso: now, reopenedBy: gate.userId },
  );
  const patch: Record<string, unknown> = { manifest_data, updated_at: now };
  if (actor.userId && isUuidString(actor.userId)) patch.updated_by = actor.userId;

  const { error: pkgUpdErr } = await supabaseServer
    .from("packages")
    .update(patch)
    .eq("id", anchor.packageId)
    .eq("organization_id", organizationId);
  if (pkgUpdErr) return { ok: false, message: pkgUpdErr.message };

  await insertOperatorPackageAuditLog({
    organizationId,
    packageId: anchor.packageId,
    action: "shipment_receive_reopen",
    field: "operator_shipment_receive_close",
    oldValue: "finalized",
    newValue: reason || "open",
    actor: actor.displayName || gate.userId,
  });

  return { ok: true, close_state: "open", storage_kind: "package_manifest_data" };
}

/**
 * Load a single package row for Box Info hydration (service role + org check).
 * Use instead of browser Supabase on `packages`, which may be blocked by RLS.
 */
export async function getOperatorIntakeBoxPackageRowAction(
  requestedOrganizationId: string,
  packageId: string,
  storeId?: string | null,
): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const pkgId = String(packageId ?? "").trim();
  if (!isUuidString(pkgId)) {
    return { ok: false, message: "Invalid package id." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const { data, error } = await supabaseServer
    .from("packages")
    .select(
      "id, package_code, outside_photo_urls, inside_photo_urls, slip_photo_urls, id_slip_contents, rma_number, manifest_data, notes, carrier_name, order_id, store_id",
    )
    .eq("id", pkgId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  if (!data) {
    return { ok: false, message: "Package not found for this organization." };
  }

  const scope = String(storeId ?? "").trim();
  const pkgStore = String((data as { store_id?: string | null }).store_id ?? "").trim();
  if (scope && isUuidString(scope) && pkgStore && isUuidString(pkgStore) && pkgStore !== scope) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  return { ok: true, row: data as Record<string, unknown> };
}

export type CreateOperatorPalletActionInput = {
  requestedOrganizationId: string;
  storeId: string;
  palletNumber: string;
  trackingNumber?: string | null;
  operatorPackageCount: number | null;
};

export type CreateOperatorPalletActionResult =
  | { ok: true; id: string; pallet_number: string }
  | { ok: false; error: string; duplicatePallet?: OperatorPalletTrackingRow; duplicateWrongStore?: boolean };

/** Save & Start (shipment commit) — service-role pallet update + audit columns. */
export type CommitOperatorPalletShipmentStepInput = {
  requestedOrganizationId: string;
  palletId: string;
  carrier_name: string | null;
  order_id: string | null;
  operator_package_count: number | null;
  tracking_number: string | null;
  /** Up to three shipping label images. */
  shipping_label_photo_urls: string[];
  /** Up to three pallet photos. */
  pallet_photo_urls: string[];
  /** Up to three BOL images. */
  bol_photo_urls: string[];
  /** Operator / collaboration notes (pallets.notes). */
  notes?: string | null;
};

export async function commitOperatorPalletShipmentStepAction(
  input: CommitOperatorPalletShipmentStepInput,
): Promise<
  | { ok: true; creatorDisplayLabel: string; createdByUserId: string | null }
  | { ok: false; message: string }
> {
  const palletId = String(input.palletId ?? "").trim();
  if (!isUuidString(palletId)) {
    return { ok: false, message: "Invalid pallet." };
  }

  const carrierTrimmed = String(input.carrier_name ?? "").trim();
  if (!carrierTrimmed) {
    return { ok: false, message: "Carrier is required — select or enter a carrier." };
  }

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const actor = await resolveAuditActorForSession();

  const { data: existing, error: selErr } = await supabaseServer
    .from("pallets")
    .select("id, organization_id, created_by, store_id")
    .eq("id", palletId)
    .maybeSingle();

  if (selErr) return { ok: false, message: selErr.message };
  const ex = existing as {
    organization_id?: string | null;
    created_by?: string | null;
    store_id?: string | null;
  } | null;
  if (!ex || String(ex.organization_id ?? "").trim() !== organizationId) {
    return { ok: false, message: "Pallet not found for this organization." };
  }

  const labelUrls = sanitizePublicMediaUrlStrings(input.shipping_label_photo_urls, 3);
  const palletUrls = sanitizePublicMediaUrlStrings(input.pallet_photo_urls, 3);
  const bolUrls = sanitizePublicMediaUrlStrings(input.bol_photo_urls, 3);

  if (!labelUrls.length) {
    return { ok: false, message: "At least one shipping label photo is required." };
  }

  const payload: Record<string, unknown> = {
    carrier_name: carrierTrimmed,
    order_id: input.order_id,
    operator_package_count: input.operator_package_count,
    tracking_number: input.tracking_number,
    shipping_label_urls: labelUrls,
    pallet_photo_urls: palletUrls,
    bol_photo_urls: bolUrls,
  };
  if (input.notes !== undefined) {
    const n = String(input.notes ?? "").trim();
    payload.notes = n.length ? n : null;
  }

  const trackingCell = input.tracking_number != null ? String(input.tracking_number).trim() : "";
  const trackingNorm =
    trackingCell.length > 0 ? normalizeTrackingKey(trackingCell) || trackingCell : "";
  if (trackingNorm.length > 0) {
    const hit = await findPalletInOrgByScanCode(supabaseServer, organizationId, trackingNorm);
    const hitId = String(hit?.id ?? "").trim();
    if (hit && hitId && hitId !== palletId) {
      const targetStoreId = String(ex.store_id ?? "").trim();
      if (!isUuidString(targetStoreId)) {
        return {
          ok: false,
          message: "Could not resolve store for this pallet — tracking was not saved.",
        };
      }
      const dupRes = await palletDupResultFromExisting(hit, targetStoreId, organizationId);
      return { ok: false, message: dupRes.error };
    }
  }

  const creatorMissing = !(String(ex.created_by ?? "").trim());
  if (creatorMissing && actor.userId) {
    payload.created_by = actor.userId;
  }

  const { error: upErr } = await supabaseServer
    .from("pallets")
    .update(payload)
    .eq("id", palletId)
    .eq("organization_id", organizationId);

  if (upErr) return { ok: false, message: upErr.message };

  const { data: after } = await supabaseServer.from("pallets").select("created_by").eq("id", palletId).maybeSingle();
  const creatorId = String((after as { created_by?: string | null })?.created_by ?? "").trim();
  let creatorDisplayLabel = "Unknown";
  if (creatorId && isUuidString(creatorId)) {
    creatorDisplayLabel = (await resolveDisplayLabelForUserId(creatorId)) ?? "Unknown";
  }
  return {
    ok: true,
    creatorDisplayLabel,
    createdByUserId: creatorId && isUuidString(creatorId) ? creatorId : null,
  };
}

/**
 * Load an existing pallet in the org by inbound tracking (normalized match).
 * When `activeStoreId` is set, pallets registered to another store are hidden (`wrongStore`).
 */
const PALLET_TRACKING_DUP_SAME_STORE = "Tracking already exists in this store.";

async function palletDupResultFromExisting(
  existing: OperatorPalletTrackingRow,
  targetStoreId: string,
  organizationId: string,
): Promise<Extract<CreateOperatorPalletActionResult, { ok: false }>> {
  const es = String(existing.store_id ?? "").trim();
  const wrong = Boolean(es && isUuidString(es) && es !== targetStoreId);
  if (!wrong) {
    return {
      ok: false,
      error: PALLET_TRACKING_DUP_SAME_STORE,
      duplicatePallet: existing,
      duplicateWrongStore: false,
    };
  }
  const storeLabel =
    (await fetchStoreDisplayNameForOrganization(supabaseServer, organizationId, es)) ?? "";
  return {
    ok: false,
    error: formatUnauthorizedTrackingInStoreMessage(storeLabel),
    duplicateWrongStore: true,
  };
}

export async function findOperatorPalletByIdAction(
  requestedOrganizationId: string,
  palletId: string,
  activeStoreId?: string | null,
): Promise<
  | { ok: true; pallet: OperatorPalletTrackingRow | null; wrongStore?: boolean; wrongStoreMessage?: string }
  | { ok: false; error: string }
> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }

  const pid = String(palletId ?? "").trim();
  if (!pid || !isUuidString(pid)) {
    return { ok: true, pallet: null };
  }

  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }

  try {
    const pallet = await findPalletByIdForOperator(supabaseServer, organizationId, pid);
    const active = String(activeStoreId ?? "").trim();
    if (pallet && active && isUuidString(active)) {
      const ps = String(pallet.store_id ?? "").trim();
      if (ps && isUuidString(ps) && ps !== active) {
        const storeLabel =
          (await fetchStoreDisplayNameForOrganization(supabaseServer, organizationId, ps)) ?? "";
        return {
          ok: true,
          pallet: null,
          wrongStore: true,
          wrongStoreMessage: formatUnauthorizedTrackingInStoreMessage(storeLabel),
        };
      }
    }
    return { ok: true, pallet };
  } catch (e) {
    const msg = formatSupabaseActionError(e, "Lookup failed.");
    console.error("[findOperatorPalletByIdAction]", msg, e);
    return { ok: false, error: msg };
  }
}

const OPERATOR_SAVED_PACKAGE_RESUME_SELECT =
  "id, package_code, tracking_number, pallet_id, slip_photo_urls, outside_photo_urls, inside_photo_urls, manifest_data, carrier_name, order_id, rma_number, notes, id_slip_contents, expected_item_count, actual_item_count, store_id";

export type OperatorSavedPackageResumeRow = {
  id: string;
  package_code: string | null;
  tracking_number: string | null;
  pallet_id: string | null;
  slip_photo_urls: unknown;
  outside_photo_urls: unknown;
  inside_photo_urls: unknown;
  manifest_data: unknown;
  carrier_name: string | null;
  order_id: string | null;
  rma_number: string | null;
  notes: string | null;
  id_slip_contents: string | null;
  expected_item_count?: number | null;
  actual_item_count?: number | null;
  store_id: string | null;
};

function savedPackageMatchesStoreScope(
  packageStoreId: string | null | undefined,
  storeScope: string | null | undefined,
): boolean {
  const scope = String(storeScope ?? "").trim();
  const pkgStore = String(packageStoreId ?? "").trim();
  if (!scope || !isUuidString(scope)) return true;
  if (!pkgStore || !isUuidString(pkgStore)) return true;
  return pkgStore === scope;
}

function pickScopedSavedPackageRow(
  rows: OperatorSavedPackageResumeRow[],
  storeScope: string | null | undefined,
): {
  row: OperatorSavedPackageResumeRow | null;
  wrongStore?: boolean;
  wrongStoreMessage?: string;
} {
  if (!rows.length) return { row: null };
  const inScope = rows.find((r) => savedPackageMatchesStoreScope(r.store_id, storeScope));
  if (inScope) return { row: inScope };
  const scope = String(storeScope ?? "").trim();
  if (!scope || !isUuidString(scope)) return { row: rows[0] ?? null };
  const foreign = rows[0];
  const pkgStore = String(foreign?.store_id ?? "").trim();
  if (pkgStore && isUuidString(pkgStore) && pkgStore !== scope) {
    return { row: null, wrongStore: true };
  }
  return { row: rows[0] ?? null };
}

async function listSavedPackagesByColumnIlike(
  organizationId: string,
  column: "package_code" | "tracking_number",
  code: string,
  limit = 5,
): Promise<OperatorSavedPackageResumeRow[]> {
  const { data, error } = await supabaseServer
    .from("packages")
    .select(OPERATOR_SAVED_PACKAGE_RESUME_SELECT)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .ilike(column, code)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as OperatorSavedPackageResumeRow[];
}

async function findSavedPackageByTrackingNormalized(
  organizationId: string,
  raw: string,
): Promise<OperatorSavedPackageResumeRow | null> {
  const key = normalizeTrackingKey(raw);
  if (!key) return null;
  const PAGE = 200;
  for (let off = 0; off < 6000; off += PAGE) {
    const { data, error } = await supabaseServer
      .from("packages")
      .select(OPERATOR_SAVED_PACKAGE_RESUME_SELECT)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .not("tracking_number", "is", null)
      .order("updated_at", { ascending: false })
      .range(off, off + PAGE - 1);
    if (error) throw error;
    const hit = (data ?? []).find(
      (row) =>
        normalizeTrackingKey(String((row as OperatorSavedPackageResumeRow).tracking_number ?? "")) === key,
    );
    if (hit) return hit as OperatorSavedPackageResumeRow;
    if (!data?.length || data.length < PAGE) break;
  }
  return null;
}

/**
 * Service-role lookup for an already-saved `packages` row by carton code or tracking (operator resume).
 * Used before creating a fresh direct-box session with `packageId: null`.
 */
export async function findOperatorSavedPackageByCodeOrTrackingAction(
  requestedOrganizationId: string,
  code: string,
  activeStoreId?: string | null,
): Promise<
  | { ok: true; package: OperatorSavedPackageResumeRow | null; wrongStore?: boolean; wrongStoreMessage?: string }
  | { ok: false; error: string }
> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }

  const raw = String(code ?? "").trim();
  if (!raw) {
    return { ok: true, package: null };
  }

  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }

  const storeScope = String(activeStoreId ?? "").trim();

  try {
    let candidates: OperatorSavedPackageResumeRow[] = [];
    const byCode = await listSavedPackagesByColumnIlike(organizationId, "package_code", raw);
    if (byCode.length) candidates = byCode;
    if (!candidates.length) {
      const byTn = await listSavedPackagesByColumnIlike(organizationId, "tracking_number", raw);
      if (byTn.length) candidates = byTn;
    }
    if (!candidates.length) {
      const byNorm = await findSavedPackageByTrackingNormalized(organizationId, raw);
      if (byNorm) candidates = [byNorm];
    }

    const picked = pickScopedSavedPackageRow(candidates, storeScope || null);
    if (picked.wrongStore) {
      const foreignStore = String(candidates[0]?.store_id ?? "").trim();
      const storeLabel =
        foreignStore && isUuidString(foreignStore)
          ? (await fetchStoreDisplayNameForOrganization(supabaseServer, organizationId, foreignStore)) ?? ""
          : "";
      return {
        ok: true,
        package: null,
        wrongStore: true,
        wrongStoreMessage: formatUnauthorizedPackageInStoreMessage(storeLabel),
      };
    }
    return { ok: true, package: picked.row };
  } catch (e) {
    const msg = formatSupabaseActionError(e, "Package lookup failed.");
    console.error("[findOperatorSavedPackageByCodeOrTrackingAction]", msg, e);
    return { ok: false, error: msg };
  }
}

export async function findOperatorPalletByTrackingNumberAction(
  requestedOrganizationId: string,
  trackingNumber: string,
  activeStoreId?: string | null,
): Promise<
  | { ok: true; pallet: OperatorPalletTrackingRow | null; wrongStore?: boolean; wrongStoreMessage?: string }
  | { ok: false; error: string }
> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }

  const raw = String(trackingNumber ?? "").trim();
  if (!raw) {
    return { ok: true, pallet: null };
  }

  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }

  try {
    const pallet = await findPalletInOrgByScanCode(supabaseServer, organizationId, raw);
    const active = String(activeStoreId ?? "").trim();
    if (pallet && active && isUuidString(active)) {
      const ps = String(pallet.store_id ?? "").trim();
      if (ps && isUuidString(ps) && ps !== active) {
        const storeLabel =
          (await fetchStoreDisplayNameForOrganization(supabaseServer, organizationId, ps)) ?? "";
        return {
          ok: true,
          pallet: null,
          wrongStore: true,
          wrongStoreMessage: formatUnauthorizedTrackingInStoreMessage(storeLabel),
        };
      }
    }
    return { ok: true, pallet };
  } catch (e) {
    const msg = formatSupabaseActionError(e, "Lookup failed.");
    console.error("[findOperatorPalletByTrackingNumberAction]", msg, e);
    return { ok: false, error: msg };
  }
}

export async function createOperatorPalletAction(
  input: CreateOperatorPalletActionInput,
): Promise<CreateOperatorPalletActionResult> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }

  const palletNumber = String(input.palletNumber ?? "").trim();
  if (!palletNumber) {
    return { ok: false, error: "Pallet code is required." };
  }

  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, error: "Invalid store." };
  }

  const trackingRaw = input.trackingNumber != null ? String(input.trackingNumber).trim() : "";
  const tracking_number =
    normalizeTrackingKey(trackingRaw || palletNumber) || trackingRaw || palletNumber;

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }

  const { data: storeRow, error: storeErr } = await supabaseServer
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .maybeSingle();
  if (storeErr) return { ok: false, error: storeErr.message };
  if (!storeRow) {
    return { ok: false, error: "Store not found for this organization." };
  }

  const pkgCount = input.operatorPackageCount;
  const operator_package_count =
    typeof pkgCount === "number" && Number.isFinite(pkgCount) ? pkgCount : null;

  let existing = await findPalletInOrgByScanCode(supabaseServer, organizationId, palletNumber);
  if (!existing && tracking_number !== palletNumber) {
    existing = await findPalletInOrgByScanCode(supabaseServer, organizationId, tracking_number);
  }
  if (existing) {
    return palletDupResultFromExisting(existing, storeId, organizationId);
  }

  const actor = await resolveAuditActorForSession();
  const insertRow: Record<string, unknown> = {
    organization_id: organizationId,
    store_id: storeId,
    pallet_number: palletNumber,
    status: "open",
    tracking_number,
    operator_package_count,
  };
  if (actor.userId) insertRow.created_by = actor.userId;

  const { data, error } = await supabaseServer
    .from("pallets")
    .insert(insertRow)
    .select("id, pallet_number")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      let dup = await findPalletInOrgByScanCode(supabaseServer, organizationId, palletNumber);
      if (!dup) {
        dup = await findPalletInOrgByScanCode(supabaseServer, organizationId, tracking_number);
      }
      if (dup) {
        return palletDupResultFromExisting(dup, storeId, organizationId);
      }
      return { ok: false, error: PALLET_TRACKING_DUP_SAME_STORE };
    }
    return { ok: false, error: error.message };
  }
  const row = data as { id?: string; pallet_number?: string } | null;
  const id = typeof row?.id === "string" ? row.id.trim() : "";
  const pn = typeof row?.pallet_number === "string" ? row.pallet_number.trim() : "";
  if (!id || !pn) {
    return { ok: false, error: "Pallet insert returned no row." };
  }

  return { ok: true, id, pallet_number: pn };
}

export type InsertOperatorIntakeBoxPackageInput = {
  requestedOrganizationId: string;
  palletId: string | null;
  packageNumber: string;
  /** Parent shipment / pallet tracking — many boxes may share it; not used for upsert dedupe. */
  shipmentTrackingNumber?: string | null;
  storeId?: string | null;
};

export type InsertOperatorIntakeBoxPackageResult =
  | { ok: true; packageId: string; reusedExisting?: boolean }
  | { ok: false; message: string };

/**
 * BOX intake package insert — must run server-side with the service role so it still works when
 * the operator UI targets a workspace-selected org: browser RLS only allows
 * `packages.organization_id = profiles.organization_id` for the JWT user, not the switched tenant.
 */
export async function insertOperatorIntakeBoxPackageAction(
  input: InsertOperatorIntakeBoxPackageInput,
): Promise<InsertOperatorIntakeBoxPackageResult> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }

  const packageNumber = String(input.packageNumber ?? "").trim();
  if (!packageNumber) {
    return { ok: false, message: "Empty barcode." };
  }

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const storeRaw = String(input.storeId ?? "").trim();
  if (storeRaw) {
    if (!isUuidString(storeRaw)) {
      return { ok: false, message: "Invalid store." };
    }
    const { data: storeRow, error: storeErr } = await supabaseServer
      .from("stores")
      .select("id")
      .eq("id", storeRaw)
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .maybeSingle();
    if (storeErr) return { ok: false, message: storeErr.message };
    if (!storeRow) {
      return { ok: false, message: "Store not found for this organization." };
    }
  }

  const palletRaw = input.palletId != null ? String(input.palletId).trim() : "";
  let palletIdFk: string | null = null;
  if (palletRaw && isUuidString(palletRaw)) {
    const { data: plt, error: pltErr } = await supabaseServer
      .from("pallets")
      .select("id")
      .eq("id", palletRaw)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (pltErr) return { ok: false, message: pltErr.message };
    if (!plt) {
      return { ok: false, message: "Pallet not found for this organization." };
    }
    palletIdFk = palletRaw;
  }

  let shipmentTracking =
    input.shipmentTrackingNumber != null ? String(input.shipmentTrackingNumber).trim() : "";
  if (!shipmentTracking && palletIdFk) {
    const { data: pltTn, error: pltTnErr } = await supabaseServer
      .from("pallets")
      .select("tracking_number")
      .eq("id", palletIdFk)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!pltTnErr && pltTn) {
      shipmentTracking = String((pltTn as { tracking_number?: string | null }).tracking_number ?? "").trim();
    }
  }

  const actor = await resolveAuditActorForSession();
  return insertIntakeBoxPackage(supabaseServer, {
    organizationId,
    palletId: palletIdFk,
    packageNumber,
    shipmentTrackingNumber: shipmentTracking || null,
    storeId: storeRaw || null,
    created_by: actor.userId ?? null,
  });
}

export type InsertOperatorUnknownPackageInput = {
  requestedOrganizationId: string;
  storeId: string;
  scannedCode: string;
};

/**
 * Placeholder `packages` row for an unmatched tracking-style scan at identify gate.
 * Uses service role so workspace org selection still works (browser insert hits RLS).
 */
export async function insertOperatorUnknownPackageAction(
  input: InsertOperatorUnknownPackageInput,
): Promise<{ ok: true; packageId: string } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }

  const code = String(input.scannedCode ?? "").trim();
  if (!code) {
    return { ok: false, message: "Empty code." };
  }

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, message: "Invalid store." };
  }

  const { data: storeRow, error: storeErr } = await supabaseServer
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .maybeSingle();
  if (storeErr) return { ok: false, message: storeErr.message };
  if (!storeRow) {
    return { ok: false, message: "Store not found for this organization." };
  }

  const actor = await resolveAuditActorForSession();
  return insertUnknownPackageForTrackingCode(supabaseServer, {
    organizationId,
    storeId,
    scannedCode: code,
    created_by: actor.userId ?? null,
  });
}

export type UpdateOperatorIntakeBoxPackageSlipLine = {
  upc: string | null;
  fnsku: string | null;
  /** B0… ASIN from vision when distinct from FNSKU. */
  printed_asin?: string | null;
  description: string | null;
  expected_qty: number;
  condition: string | null;
  /** Line marked missing vs physical slip (persisted in manifest JSON + UI). */
  missing?: boolean;
};

/**
 * Secure BOX intake **update / upsert** (service role + `resolveWriteOrganizationId`).
 *
 * - **Package row**: only keys present on `packageUpdate` are written (partial patches supported).
 * - **Pallet** (optional): when `palletId` + `palletUpdate` are set, pallet must belong to the resolved org.
 * - **slip_contents**: `replace` **replaces** all rows for the package (delete where `package_id`, then insert `lines`).
 *   This avoids duplicate lines for the same package and matches a full “snapshot” of the current slip table.
 */
export type DuplicatePackingSlipInfo = {
  slipCode: string;
  otherPackageCode: string;
};

export type UpdateOperatorIntakeBoxPackageResult =
  | {
      ok: true;
      palletMixedOrderIds?: boolean;
      palletOrderIdFromDb?: string | null;
      /** Token stored on every `slip_contents` row for this slip (RMA-derived). */
      slipContentsOrderId?: string | null;
      /** When set, equals `slip_contents.conflicting_order_id` (pallet side of a recorded mismatch). */
      slipConflictingOrderId?: string | null;
    }
  | { ok: false; message: string; duplicatePackingSlip?: DuplicatePackingSlipInfo };

async function findDuplicatePackageForSlipContents(
  organizationId: string,
  slipCode: string,
  excludePackageId: string,
): Promise<{ package_code: string | null } | null> {
  const slip = slipCode.trim();
  if (!slip) return null;
  let q = supabaseServer
    .from("packages")
    .select("id, package_code")
    .eq("organization_id", organizationId)
    .eq("id_slip_contents", slip)
    .is("deleted_at", null);
  if (isUuidString(excludePackageId)) {
    q = q.neq("id", excludePackageId);
  }
  const { data, error } = await q.limit(1).maybeSingle();
  if (error || !data) return null;
  return data as { package_code: string | null };
}

/**
 * Returns whether `id_slip_contents` is already used on a different package in the org.
 * `excludePackageId` — UUID of the current box (omit or empty when the row does not exist yet).
 */
export async function checkOperatorSlipCodeDuplicateAction(
  requestedOrganizationId: string,
  slipCode: string,
  excludePackageId: string | null,
): Promise<
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true; slipCode: string; otherPackageCode: string; message: string }
  | { ok: false; error: string }
> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }
  const slip = String(slipCode ?? "").trim();
  if (!slip) return { ok: true, duplicate: false };
  const ex = String(excludePackageId ?? "").trim();
  const dup = await findDuplicatePackageForSlipContents(
    organizationId,
    slip,
    isUuidString(ex) ? ex : "",
  );
  if (!dup) return { ok: true, duplicate: false };
  const otherPackageCode = String(dup.package_code ?? "").trim() || "—";
  return {
    ok: true,
    duplicate: true,
    slipCode: slip,
    otherPackageCode,
    message: formatDuplicatePackingSlipMessage(slip, otherPackageCode),
  };
}

/** Trim only — never treat a non-empty id as empty (no lowercase here). */
function normalizeMarketplaceOrderId(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length ? s : null;
}

export type UpdateOperatorIntakeBoxPackageInput = {
  requestedOrganizationId: string;
  /** Session store — preferred for `slip_contents.store_id` when replacing lines. */
  storeId?: string | null;
  packageId: string;
  palletId?: string | null;
  palletUpdate?: {
    carrier_name: string;
    order_id: string | null;
    shipping_label_urls: string[];
  } | null;
  packageUpdate: {
    outside_photo_urls?: string[];
    inside_photo_urls?: string[];
    slip_photo_urls?: string[];
    package_code?: string | null;
    carrier_name?: string | null;
    /** Parent shipment / pallet tracking — optional, not a unique key. */
    tracking_number?: string | null;
    /** Marketplace / removal order id for this package (`packages.order_id`). */
    order_id?: string | null;
    id_slip_contents?: string | null;
    rma_number?: string | null;
    manifest_data?: Record<string, unknown>;
    /** packages.notes — collaboration / discrepancy text. */
    notes?: string | null;
  };
  slipContents:
    | { mode: "replace"; lines: UpdateOperatorIntakeBoxPackageSlipLine[]; slipCode: string | null }
    | { mode: "skip" };
};

/** RMA / RA string sent with slip replace (field + manifest fallback when OCR omitted `rma_number`). */
function probeSlipReferenceFromPackageUpdate(
  pu: UpdateOperatorIntakeBoxPackageInput["packageUpdate"],
): string {
  const fromField = pu.rma_number !== undefined ? String(pu.rma_number ?? "").trim() : "";
  if (fromField) return fromField;
  const md = pu.manifest_data;
  if (!md || typeof md !== "object" || Array.isArray(md)) return "";
  const box = (md as Record<string, unknown>).box_slip_vision;
  if (!box || typeof box !== "object" || Array.isArray(box)) return "";
  return String((box as Record<string, unknown>).rma_number ?? "").trim();
}

/**
 * BOX intake package update (+ optional pallet + slip_contents replace).
 * Same workspace resolution as {@link insertOperatorIntakeBoxPackageAction}.
 */
export async function updateOperatorIntakeBoxPackageAction(
  input: UpdateOperatorIntakeBoxPackageInput,
): Promise<UpdateOperatorIntakeBoxPackageResult> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }

  const packageId = String(input.packageId ?? "").trim();
  if (!isUuidString(packageId)) {
    return { ok: false, message: "Invalid package id." };
  }

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const { data: pkgRow, error: pkgSelErr } = await supabaseServer
    .from("packages")
    .select("id, organization_id, store_id")
    .eq("id", packageId)
    .maybeSingle();
  if (pkgSelErr) return { ok: false, message: pkgSelErr.message };
  const pkgTyped = pkgRow as { organization_id?: string; store_id?: string | null } | null;
  const pkgOrg = String(pkgTyped?.organization_id ?? "").trim();
  if (!pkgRow || pkgOrg !== organizationId) {
    return { ok: false, message: "Package not found for this organization." };
  }

  const inputStoreRaw = input.storeId != null ? String(input.storeId).trim() : "";
  const pkgStoreRaw = String(pkgTyped?.store_id ?? "").trim();
  if (inputStoreRaw && isUuidString(inputStoreRaw) && pkgStoreRaw && isUuidString(pkgStoreRaw)) {
    if (pkgStoreRaw !== inputStoreRaw) {
      const storeLabel =
        (await fetchStoreDisplayNameForOrganization(supabaseServer, organizationId, pkgStoreRaw)) ?? "";
      return {
        ok: false,
        message: formatUnauthorizedPackageInStoreMessage(storeLabel),
      };
    }
  }
  const slipStoreId: string | null =
    inputStoreRaw && isUuidString(inputStoreRaw)
      ? inputStoreRaw
      : pkgStoreRaw && isUuidString(pkgStoreRaw)
        ? pkgStoreRaw
        : null;

  const pu = input.packageUpdate;
  let slipForDup: string | null = null;
  if (pu.id_slip_contents !== undefined) {
    const t = String(pu.id_slip_contents ?? "").trim();
    if (t) slipForDup = t;
  }
  if (!slipForDup && input.slipContents.mode === "replace") {
    const t = String(input.slipContents.slipCode ?? "").trim();
    if (t) slipForDup = t;
  }
  if (slipForDup) {
    const dupRow = await findDuplicatePackageForSlipContents(organizationId, slipForDup, packageId);
    if (dupRow) {
      const otherPackageCode = String(dupRow.package_code ?? "").trim() || "—";
      return {
        ok: false,
        message: formatDuplicatePackingSlipMessage(slipForDup, otherPackageCode),
        duplicatePackingSlip: { slipCode: slipForDup, otherPackageCode },
      };
    }
  }

  const actor = await resolveAuditActorForSession();
  const uid = actor.userId?.trim() || null;

  const pkgPatch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (pu.outside_photo_urls !== undefined) {
    pkgPatch.outside_photo_urls = sanitizePublicMediaUrlStrings(pu.outside_photo_urls, 3);
  }
  if (pu.inside_photo_urls !== undefined) {
    pkgPatch.inside_photo_urls = sanitizePublicMediaUrlStrings(pu.inside_photo_urls, 3);
  }
  if (pu.slip_photo_urls !== undefined) {
    pkgPatch.slip_photo_urls = sanitizePublicMediaUrlStrings(pu.slip_photo_urls, 3);
  }
  if (pu.package_code !== undefined) pkgPatch.package_code = pu.package_code;
  if (pu.carrier_name !== undefined) pkgPatch.carrier_name = pu.carrier_name;
  if (pu.tracking_number !== undefined) pkgPatch.tracking_number = pu.tracking_number;
  if (pu.order_id !== undefined) {
    pkgPatch.order_id = normalizeMarketplaceOrderId(pu.order_id);
  }
  if (pu.id_slip_contents !== undefined) pkgPatch.id_slip_contents = pu.id_slip_contents;
  if (pu.rma_number !== undefined) pkgPatch.rma_number = pu.rma_number;
  if (pu.manifest_data !== undefined) pkgPatch.manifest_data = pu.manifest_data;
  if (pu.notes !== undefined) {
    const n = String(pu.notes ?? "").trim();
    pkgPatch.notes = n.length ? n : null;
  }
  if (uid) pkgPatch.updated_by = uid;

  const palletRaw = input.palletId != null ? String(input.palletId).trim() : "";
  const hasPalletUuid = Boolean(palletRaw && isUuidString(palletRaw));

  let slipContentsOrderIdForInsert: string | null = null;
  let slipConflictingOrderIdForInsert: string | null = null;
  let smartRaCaseA = false;
  let palletMixedOrderIds = false;

  const linesPreview =
    input.slipContents.mode === "replace" ? input.slipContents.lines : [];
  const slipReferenceRaw =
    input.slipContents.mode === "replace" ? probeSlipReferenceFromPackageUpdate(pu) : "";
  const extractedForCompare =
    slipReferenceRaw.length > 0 ? extractSlipOrderTokenForPalletCompare(slipReferenceRaw) : null;

  if (input.slipContents.mode === "replace" && linesPreview.length > 0 && extractedForCompare) {
    /** Canonical slip token on every line (`slip_contents.order_id`). */
    slipContentsOrderIdForInsert = extractedForCompare;
    if (hasPalletUuid) {
      const { data: pltSmart, error: pltSmartErr } = await supabaseServer
        .from("pallets")
        .select("order_id")
        .eq("id", palletRaw)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!pltSmartErr && pltSmart) {
        const palletOrderId = normalizeMarketplaceOrderId((pltSmart as { order_id?: unknown }).order_id);
        const extractedId = extractedForCompare;
        console.log("Comparing Slip:", extractedId, "with Pallet:", palletOrderId ?? "(empty)");
        if (!palletOrderId) {
          smartRaCaseA = true;
          pkgPatch.order_id = extractedForCompare;
        } else if (palletOrderId.toLowerCase() !== extractedForCompare.toLowerCase()) {
          // Slip line: order_id = slip token; conflicting_order_id = pallet’s assigned id (never duplicate when match).
          slipConflictingOrderIdForInsert = palletOrderId;
          palletMixedOrderIds = true;
        }
      }
    }
  }

  const patchKeys = Object.keys(pkgPatch).filter((k) => k !== "updated_at" && k !== "updated_by");
  const willReplaceSlipContents = input.slipContents.mode === "replace";
  const willUpdatePackageRow = patchKeys.length > 0 || Boolean(uid);

  const willEvaluatePallet =
    hasPalletUuid &&
    (Boolean(input.palletUpdate) || pu.order_id !== undefined || smartRaCaseA);

  if (!willUpdatePackageRow && !willReplaceSlipContents && !willEvaluatePallet) {
    return { ok: false, message: "Nothing to update." };
  }

  console.log("[updateOperatorIntakeBoxPackageAction] start", {
    packageId,
    willUpdatePackageRow,
    patchKeys,
    willReplaceSlipContents,
    willEvaluatePallet,
    hasPalletUuid,
  });

  // --- Step A: persist package row first (independent of pallet). No DB transaction wrapper — each statement auto-commits. ---
  if (willUpdatePackageRow) {
    console.log("[updateOperatorIntakeBoxPackageAction] stepA: packages.update", { keys: patchKeys });
    const { error: pke } = await supabaseServer.from("packages").update(pkgPatch).eq("id", packageId);
    if (pke) {
      console.log("[updateOperatorIntakeBoxPackageAction] stepA: FAIL", pke.message);
      return { ok: false, message: pke.message };
    }
    console.log("[updateOperatorIntakeBoxPackageAction] stepA: OK");
  } else {
    console.log("[updateOperatorIntakeBoxPackageAction] stepA: skip (no package column patch / audit uid)");
  }

  if (input.slipContents.mode === "replace") {
    console.log("[updateOperatorIntakeBoxPackageAction] step: slip_contents replace");
    const { error: delE } = await supabaseServer.from("slip_contents").delete().eq("package_id", packageId);
    if (delE) {
      console.log("[updateOperatorIntakeBoxPackageAction] slip delete FAIL", delE.message);
      return { ok: false, message: delE.message };
    }

    const lines = input.slipContents.lines;
    if (lines.length > 0) {
      const rmaPersist = pu.rma_number !== undefined ? pu.rma_number : null;
      const slipLineCode =
        input.slipContents.mode === "replace"
          ? String(input.slipContents.slipCode ?? "").trim() || null
          : null;
      const rows = lines.map((line, i) => {
        const parsed = slipVisionLineIdentifierFields({
          upc: line.upc,
          fnsku: line.fnsku,
          printed_asin: line.printed_asin,
        });
        return {
          organization_id: organizationId,
          package_id: packageId,
          store_id: slipStoreId,
          slip_code: slipLineCode,
          rma_number: rmaPersist,
          upc: line.upc?.trim() || null,
          fnsku: parsed.parsed_fnsku,
          description: line.description?.trim() || null,
          quantity: line.expected_qty,
          condition: line.condition?.trim() || null,
          sort_index: i,
          parsed_asin: parsed.parsed_asin,
          parsed_fnsku: parsed.parsed_fnsku,
          parsed_upc: parsed.parsed_upc,
          ...(slipContentsOrderIdForInsert ? { order_id: slipContentsOrderIdForInsert } : {}),
          ...(slipConflictingOrderIdForInsert
            ? { conflicting_order_id: slipConflictingOrderIdForInsert }
            : {}),
          ...(uid ? { created_by: uid } : {}),
        };
      });
      type SlipInsertRow = Record<string, unknown>;
      let insertRows: SlipInsertRow[] = rows as SlipInsertRow[];
      let insE: { message: string } | null = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const { error } = await supabaseServer.from("slip_contents").insert(insertRows);
        insE = error;
        if (!insE) break;
        const msg = insE.message;
        if (isMissingSlipContentsOrderIdSchemaError(msg)) {
          insertRows = insertRows.map(({ order_id: _o, ...rest }) => rest);
          continue;
        }
        if (isMissingSlipContentsConflictingOrderIdSchemaError(msg)) {
          insertRows = insertRows.map(({ conflicting_order_id: _c, ...rest }) => rest);
          continue;
        }
        if (isMissingSlipContentsParsedIdentifierSchemaError(msg)) {
          insertRows = insertRows.map(
            ({ parsed_asin: _a, parsed_fnsku: _f, parsed_upc: _u, ...rest }) => rest,
          );
          continue;
        }
        break;
      }
      if (insE) {
        console.log("[updateOperatorIntakeBoxPackageAction] slip insert FAIL", insE.message);
        return { ok: false, message: insE.message };
      }
      void enrichSlipContentsProductLinksAfterReplace(supabaseServer, {
        packageId,
        organizationId,
        storeId: slipStoreId,
        lines: lines.map((line, i) => ({
          sort_index: i,
          upc: line.upc,
          fnsku: line.fnsku,
          printed_asin: line.printed_asin,
          description: line.description,
        })),
      });
    }
    console.log("[updateOperatorIntakeBoxPackageAction] slip_contents: OK");
  }

  let didPalletRowUpdate = false;

  if (willEvaluatePallet) {
    console.log("[updateOperatorIntakeBoxPackageAction] stepB/C: pallet sync begin", { palletRaw });
    const { data: plt, error: pltErr } = await supabaseServer
      .from("pallets")
      .select("id, order_id")
      .eq("id", palletRaw)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (pltErr) {
      console.log("[updateOperatorIntakeBoxPackageAction] stepB/C: pallet select FAIL", pltErr.message);
      return { ok: false, message: pltErr.message };
    }
    if (!plt) {
      console.log("[updateOperatorIntakeBoxPackageAction] stepB/C: pallet not found");
      return { ok: false, message: "Pallet not found for this organization." };
    }

    const existingPalletOrderRaw = (plt as { order_id?: string | null }).order_id;
    const existingPalletOrderId = normalizeMarketplaceOrderId(existingPalletOrderRaw);

    let pkgOrderFromPackageRow: string | null = null;
    if (smartRaCaseA) {
      const { data: pkgOrdRow, error: pkgOrdErr } = await supabaseServer
        .from("packages")
        .select("order_id")
        .eq("id", packageId)
        .maybeSingle();
      if (pkgOrdErr) {
        console.warn("[updateOperatorIntakeBoxPackageAction] package order_id read (smart RA):", pkgOrdErr.message);
      } else {
        pkgOrderFromPackageRow = normalizeMarketplaceOrderId(
          (pkgOrdRow as { order_id?: unknown } | null)?.order_id,
        );
      }
    } else if (pu.order_id !== undefined) {
      pkgOrderFromPackageRow = normalizeMarketplaceOrderId(pu.order_id);
    } else {
      const { data: pkgOrdRow, error: pkgOrdErr } = await supabaseServer
        .from("packages")
        .select("order_id")
        .eq("id", packageId)
        .maybeSingle();
      if (pkgOrdErr) {
        console.warn("[updateOperatorIntakeBoxPackageAction] package order_id read:", pkgOrdErr.message);
      } else {
        pkgOrderFromPackageRow = normalizeMarketplaceOrderId(
          (pkgOrdRow as { order_id?: unknown } | null)?.order_id,
        );
      }
    }

    const packageOrderKeyPresent = pu.order_id !== undefined;
    const packageOrderNorm = packageOrderKeyPresent ? normalizeMarketplaceOrderId(pu.order_id) : undefined;
    const palletUpdateOrderNorm = input.palletUpdate
      ? normalizeMarketplaceOrderId(input.palletUpdate.order_id)
      : undefined;

    console.log("[updateOperatorIntakeBoxPackageAction] stepB/C: context", {
      existingPalletOrderId,
      pkgOrderFromPackageRow,
      packageOrderKeyPresent,
      packageOrderNorm,
      palletUpdateOrderNorm,
      smartRaCaseA,
    });

    const palletPatch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (uid) palletPatch.updated_by = uid;
    if (input.palletUpdate) {
      const labelUrls = sanitizePublicMediaUrlStrings(input.palletUpdate.shipping_label_urls, 3);
      palletPatch.carrier_name = input.palletUpdate.carrier_name;
      palletPatch.shipping_label_urls = labelUrls;
    }

    if (packageOrderKeyPresent || smartRaCaseA) {
      const orderIntentNonEmpty = normalizeMarketplaceOrderId(
        smartRaCaseA
          ? pkgOrderFromPackageRow ?? palletUpdateOrderNorm
          : packageOrderNorm ?? palletUpdateOrderNorm,
      );
      if (!existingPalletOrderId && orderIntentNonEmpty) {
        palletPatch.order_id = orderIntentNonEmpty;
        console.log("[updateOperatorIntakeBoxPackageAction] stepB: fill pallet order_id", {
          from: existingPalletOrderRaw ?? null,
          to: orderIntentNonEmpty,
        });
      } else if (
        existingPalletOrderId &&
        orderIntentNonEmpty &&
        existingPalletOrderId.toLowerCase() !== orderIntentNonEmpty.toLowerCase()
      ) {
        palletMixedOrderIds = true;
        console.log("[updateOperatorIntakeBoxPackageAction] stepC: mixed order ids (pallet order_id unchanged)", {
          existingPalletOrderId,
          orderIntentNonEmpty,
        });
      }
    } else if (input.palletUpdate) {
      palletPatch.order_id = palletUpdateOrderNorm;
    }

    const palletMeaningfulKeys = Object.keys(palletPatch).filter(
      (k) => k !== "updated_at" && k !== "updated_by",
    );
    if (palletMeaningfulKeys.length > 0) {
      console.log("[updateOperatorIntakeBoxPackageAction] stepB/C: pallets.update", {
        keys: palletMeaningfulKeys,
      });
      const { error: pe } = await supabaseServer.from("pallets").update(palletPatch).eq("id", palletRaw);
      if (pe) {
        console.log("[updateOperatorIntakeBoxPackageAction] pallets.update FAIL", pe.message);
        return { ok: false, message: pe.message };
      }
      didPalletRowUpdate = true;
      console.log("[updateOperatorIntakeBoxPackageAction] pallets.update OK");
    } else {
      console.log("[updateOperatorIntakeBoxPackageAction] stepB/C: skip pallets.update (no field changes)");
    }
  }

  let palletOrderIdFromDb: string | null | undefined;
  if (hasPalletUuid) {
    const { data: pltAfter, error: afterErr } = await supabaseServer
      .from("pallets")
      .select("order_id")
      .eq("id", palletRaw)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (afterErr) {
      console.warn("[updateOperatorIntakeBoxPackageAction] pallet order_id re-read:", afterErr.message);
    } else {
      palletOrderIdFromDb = normalizeMarketplaceOrderId((pltAfter as { order_id?: unknown } | null)?.order_id);
    }
  }

  console.log("[updateOperatorIntakeBoxPackageAction] complete", {
    palletMixedOrderIds,
    didPalletRowUpdate,
    palletOrderIdFromDb: palletOrderIdFromDb === undefined ? "(re-read skipped)" : palletOrderIdFromDb,
  });

  return {
    ok: true,
    ...(palletMixedOrderIds ? { palletMixedOrderIds: true } : {}),
    ...(palletOrderIdFromDb !== undefined ? { palletOrderIdFromDb } : {}),
    ...(slipContentsOrderIdForInsert ? { slipContentsOrderId: slipContentsOrderIdForInsert } : {}),
    ...(slipConflictingOrderIdForInsert
      ? { slipConflictingOrderId: slipConflictingOrderIdForInsert }
      : {}),
  };
}

/** Same implementation as {@link updateOperatorIntakeBoxPackageAction} — alias for docs / external naming. */
export const saveOperatorPackageAction = updateOperatorIntakeBoxPackageAction;

/** BOX slip AI persist entrypoint — delegates to {@link updateOperatorIntakeBoxPackageAction} (smart order-id logic + slip_contents write). */
export async function saveOperatorSlipVisionAction(
  input: UpdateOperatorIntakeBoxPackageInput,
): Promise<UpdateOperatorIntakeBoxPackageResult> {
  return updateOperatorIntakeBoxPackageAction(input);
}

export type FinalizeOperatorPackageReceiveInput = {
  requestedOrganizationId: string;
  storeId: string;
  packageId: string;
  palletId?: string | null;
  emptyBox?: boolean;
  expectedUnits?: number;
  scannedUnits?: number;
  notesAppend?: string | null;
};

export type FinalizeOperatorPackageReceiveResult =
  | {
      ok: true;
      package_id?: string;
      status?: string;
      receive_state?: string;
      finalize_revision?: number;
      shortage_lines_created?: number;
      shortage_lines_touched?: number;
      empty_box_case_id?: string | null;
      empty_box_evidence_count?: number;
      claim_cases_available?: boolean;
      claim_evidence_available?: boolean;
    }
  | { ok: false; message: string; schemaApprovalRequired?: boolean };

/**
 * Phase 6B — server finalize for item receive close.
 * Derives shortage claim_lines at close; optional empty_box claim_case + package evidence.
 */
export async function finalizeOperatorPackageReceiveAction(
  input: FinalizeOperatorPackageReceiveInput,
): Promise<FinalizeOperatorPackageReceiveResult> {
  const organizationId = String(input.requestedOrganizationId ?? "").trim();
  const storeId = String(input.storeId ?? "").trim();
  const packageId = String(input.packageId ?? "").trim();
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Organization is required." };
  }
  if (!storeId || !isUuidString(storeId)) {
    return { ok: false, message: "Store is required." };
  }
  if (!packageId || !isUuidString(packageId)) {
    return { ok: false, message: "Package is required." };
  }

  const gate = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_EDIT_ITEM);
  if (!gate.ok) {
    return { ok: false, message: gate.message };
  }

  const expected = Math.max(0, Math.floor(Number(input.expectedUnits) || 0));
  const scanned = Math.max(0, Math.floor(Number(input.scannedUnits) || 0));
  const discrepancy = expected !== scanned;
  const notesAppend =
    String(input.notesAppend ?? "").trim() ||
    (discrepancy ? buildPackageFinalizeDiscrepancyNote(expected, scanned) : "");

  const { data, error } = await supabaseServer.rpc("finalize_package_receive_close", {
    p_organization_id: organizationId,
    p_package_id: packageId,
    p_store_id: storeId,
    p_empty_box: Boolean(input.emptyBox),
    p_actor_profile_id: gate.userId,
    p_notes_append: notesAppend || null,
  });

  if (error) {
    return { ok: false, message: formatSupabaseActionError(error, "Package finalize failed.") };
  }

  const payload = (data ?? {}) as FinalizePackageReceiveCloseRpcResult;
  if (!payload.ok) {
    if (payload.schema_approval_required) {
      return {
        ok: false,
        message: "Empty box claim requires claim_cases schema approval on this environment.",
        schemaApprovalRequired: true,
      };
    }
    return { ok: false, message: payload.error ?? "Package finalize failed." };
  }

  if (input.palletId && isUuidString(input.palletId)) {
    await syncReturnItemsPalletForPackage(supabaseServer, {
      organizationId,
      packageId,
      palletId: input.palletId,
    });
  }

  return {
    ok: true,
    package_id: payload.package_id,
    status: payload.status,
    receive_state: payload.receive_state,
    finalize_revision: payload.finalize_revision,
    shortage_lines_created: payload.shortage_lines_created,
    shortage_lines_touched: payload.shortage_lines_touched,
    empty_box_case_id: payload.empty_box_case_id,
    empty_box_evidence_count: payload.empty_box_evidence_count,
    claim_cases_available: payload.claim_cases_available,
    claim_evidence_available: payload.claim_evidence_available,
  };
}

async function assertPackageReceiveOpenForPackageEdits(
  organizationId: string,
  packageId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const loaded = await loadPackageOperatorItemScanManifest(supabaseServer, organizationId, packageId);
  if (!loaded.ok) return { ok: false, message: loaded.error };
  const gate = assertPackageReceiveOpenForEdits(loaded.operator_item_scan);
  if (!gate.ok) return { ok: false, message: gate.error };
  return { ok: true };
}

export type PatchPackageMissingReviewRpcInput = {
  requestedOrganizationId: string;
  packageId: string;
  slipContentId?: string | null;
  marked?: boolean;
  markedMissingQty?: number;
  bulkRemaining?: boolean;
};

export type PatchPackageMissingReviewRpcResult =
  | { ok: true; operator_item_scan: ReturnType<typeof parseOperatorItemScanFromManifestData> }
  | { ok: false; message: string };

/** Maysam RPC contract: `patch_package_missing_review` (manifest metadata only — no return_items). */
export async function patchPackageMissingReviewRpcAction(
  input: PatchPackageMissingReviewRpcInput,
): Promise<PatchPackageMissingReviewRpcResult> {
  const organizationId = String(input.requestedOrganizationId ?? "").trim();
  const packageId = String(input.packageId ?? "").trim();
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Organization is required." };
  }
  if (!packageId || !isUuidString(packageId)) {
    return { ok: false, message: "Package is required." };
  }

  const gate = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_EDIT_ITEM);
  if (!gate.ok) return { ok: false, message: gate.message };

  const slipContentId = String(input.slipContentId ?? "").trim();
  const bulkRemaining = Boolean(input.bulkRemaining);
  if (!bulkRemaining && (!slipContentId || !isUuidString(slipContentId))) {
    return { ok: false, message: "Slip line id is required for per-line missing review." };
  }

  const { data, error } = await supabaseServer.rpc("patch_package_missing_review", {
    p_organization_id: organizationId,
    p_package_id: packageId,
    p_slip_content_id: bulkRemaining ? null : slipContentId,
    p_marked: input.marked !== false,
    p_marked_missing_qty: Math.max(1, Math.floor(Number(input.markedMissingQty) || 1)),
    p_bulk_remaining: bulkRemaining,
    p_actor_profile_id: gate.userId,
  });

  if (error) {
    return { ok: false, message: formatSupabaseActionError(error, "Missing review update failed.") };
  }

  const payload = (data ?? {}) as { ok?: boolean; error?: string; operator_item_scan?: unknown };
  if (!payload.ok) {
    if (payload.error === "package_finalized") {
      return { ok: false, message: "Package is finalized — reopen for correction first." };
    }
    return { ok: false, message: payload.error ?? "Missing review update failed." };
  }

  const ois = parseOperatorItemScanFromManifestData({
    operator_item_scan: payload.operator_item_scan,
  });
  return { ok: true, operator_item_scan: ois };
}

export type ReopenPackageReceiveCorrectionInput = {
  requestedOrganizationId: string;
  packageId: string;
  reason?: string | null;
};

export type ReopenPackageReceiveCorrectionResult =
  | { ok: true; finalize_revision: number; operator_item_scan: ReturnType<typeof parseOperatorItemScanFromManifestData> }
  | { ok: false; message: string };

export async function reopenPackageReceiveCorrectionAction(
  input: ReopenPackageReceiveCorrectionInput,
): Promise<ReopenPackageReceiveCorrectionResult> {
  const organizationId = String(input.requestedOrganizationId ?? "").trim();
  const packageId = String(input.packageId ?? "").trim();
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Organization is required." };
  }
  if (!packageId || !isUuidString(packageId)) {
    return { ok: false, message: "Package is required." };
  }

  const gate = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_EDIT_ITEM);
  if (!gate.ok) return { ok: false, message: gate.message };

  const { data, error } = await supabaseServer.rpc("reopen_package_receive_correction", {
    p_organization_id: organizationId,
    p_package_id: packageId,
    p_actor_profile_id: gate.userId,
    p_reason: String(input.reason ?? "").trim() || null,
  });

  if (error) {
    return { ok: false, message: formatSupabaseActionError(error, "Reopen failed.") };
  }

  const payload = (data ?? {}) as {
    ok?: boolean;
    error?: string;
    finalize_revision?: number;
    operator_item_scan?: unknown;
  };
  if (!payload.ok) {
    return { ok: false, message: payload.error ?? "Reopen failed." };
  }

  const ois = parseOperatorItemScanFromManifestData({
    operator_item_scan: payload.operator_item_scan,
  });
  return {
    ok: true,
    finalize_revision: Number(payload.finalize_revision ?? ois.finalize_revision),
    operator_item_scan: ois,
  };
}

// ---------------------------------------------------------------------------
// Item scan units — persisted on `return_items` (live DB); UI adapter shape unchanged.
// ---------------------------------------------------------------------------

function scannedBarcodeFromReturnItemRow(row: {
  fnsku?: string | null;
  sku?: string | null;
  product_identifier?: string | null;
}): string {
  const f = String(row.fnsku ?? "").trim();
  if (f) return f;
  const s = String(row.sku ?? "").trim();
  if (s) return s;
  return String(row.product_identifier ?? "").trim();
}

function slipContentIdForReturnItemBarcode(
  barcode: string,
  slipRows: SlipBarcodeMatchRow[],
): string | null {
  const trimmed = barcode.trim();
  if (!trimmed || slipRows.length === 0) return null;
  const outcome = resolveItemBarcodeAgainstSlipRows(trimmed, slipRows);
  if (outcome.kind !== "single") return null;
  const sid = String(outcome.slip.id ?? "").trim();
  return sid && isUuidString(sid) ? sid : null;
}

function returnItemUnitQty(row: Record<string, unknown>): number {
  return Math.max(1, Math.floor(Number(row.scanned_quantity ?? row.quantity ?? 1)));
}

function slipLinesToBarcodeMatchRows(lines: unknown[]): SlipBarcodeMatchRow[] {
  return lines.map((raw, idx) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id ?? "").trim() || null,
      upc: coalesceSlipRowUpc({
        upc: typeof row.upc === "string" ? row.upc : null,
        parsed_upc: typeof row.parsed_upc === "string" ? row.parsed_upc : null,
      }),
      fnsku: coalesceSlipRowFnsku({
        fnsku: typeof row.fnsku === "string" ? row.fnsku : null,
        parsed_fnsku: typeof row.parsed_fnsku === "string" ? row.parsed_fnsku : null,
      }),
      description: null,
      quantity: Math.max(0, Math.floor(Number(row.quantity ?? 0))),
      sort_index: idx,
    };
  });
}

/** Scanned qty per slip line — inferred from barcodes, never `return_items.slip_content_id`. */
function computePackageScannedQtyBySlipFromReturnItems(
  returnItemRows: unknown[],
  slipMatchRows: SlipBarcodeMatchRow[],
): { receivedBySlip: Map<string, number>; scannedQty: number } {
  const receivedBySlip = new Map<string, number>();
  let scannedQty = 0;

  for (const raw of returnItemRows) {
    const row = raw as Record<string, unknown>;
    const fnsku = typeof row.fnsku === "string" ? row.fnsku : null;
    const sku = typeof row.sku === "string" ? row.sku : null;
    const product_identifier = typeof row.product_identifier === "string" ? row.product_identifier : null;
    const operator_notes = typeof row.notes === "string" ? row.notes : null;

    if (
      shouldExcludeReturnItemFromScannerCounts({
        item_name: typeof row.item_name === "string" ? row.item_name : null,
        sku,
        fnsku,
        product_identifier,
        notes: operator_notes,
      })
    ) {
      continue;
    }

    const q = returnItemUnitQty(row);
    scannedQty += q;

    const scanned_barcode = scannedBarcodeFromReturnItemRow({ fnsku, sku, product_identifier });
    const slipId = returnItemNotesMarkOffSlip(operator_notes)
      ? null
      : slipContentIdForReturnItemBarcode(scanned_barcode, slipMatchRows);
    if (slipId && isUuidString(slipId)) {
      receivedBySlip.set(slipId, (receivedBySlip.get(slipId) ?? 0) + q);
    }
  }

  return { receivedBySlip, scannedQty };
}

async function loadPackageReturnItemsForQtyBySlip(
  pkgId: string,
  organizationId: string,
  includeId: boolean,
): Promise<{ ok: true; rows: unknown[] } | { ok: false; message: string }> {
  const idPrefix = includeId ? "id, " : "";
  const selectAttempts = [
    `${idPrefix}fnsku, sku, product_identifier, item_name, notes, scanned_quantity, quantity`,
    `${idPrefix}fnsku, sku, product_identifier, item_name, notes, quantity`,
    `${idPrefix}fnsku, sku, product_identifier, notes, scanned_quantity, quantity`,
    `${idPrefix}fnsku, sku, product_identifier, notes, quantity`,
    `${idPrefix}fnsku, sku, product_identifier, notes`,
  ];

  let returnRes: { data: unknown; error: { message: string } | null } | null = null;
  for (const sel of selectAttempts) {
    const r = await supabaseServer
      .from(RETURN_ITEMS_TABLE)
      .select(sel)
      .eq("package_id", pkgId)
      .eq("organization_id", organizationId)
      .is("deleted_at", null);
    returnRes = r;
    if (!r.error) break;
  }
  if (!returnRes || returnRes.error) {
    return { ok: false, message: returnRes?.error?.message ?? "return_items load failed." };
  }
  return { ok: true, rows: Array.isArray(returnRes.data) ? returnRes.data : [] };
}

export type OperatorPackageItemRow = {
  id: string;
  slip_content_id: string | null;
  scanned_barcode: string;
  /** Persisted return_items.fnsku when present. */
  fnsku: string | null;
  /** Persisted return_items.sku (seller SKU / UPC lane in operator UI). */
  sku: string | null;
  /** Persisted return_items.product_identifier when present. */
  product_identifier: string | null;
  match_kind: "fnsku" | "upc" | "unexpected";
  quantity: number;
  discrepancy_tags: string[] | null;
  expiry_date: string | null;
  lot_number: string | null;
  evidence_urls: string[] | null;
  /** Expiry label photos (`photo_evidence.expiry_url`). */
  expiry_evidence_urls: string[] | null;
  optional_item_photo_url: string | null;
  optional_item_photo_urls: string[] | null;
  operator_notes: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  /** Resolved via profiles / auth email in {@link listOperatorPackageItemsForPackageAction}. */
  created_by_display: string | null;
  updated_by_display: string | null;
  product_linkage: ProductLinkageDisplayContract;
};

function inferMatchKindFromReturnItemRow(row: {
  fnsku?: string | null;
  sku?: string | null;
  product_identifier?: string | null;
}): OperatorPackageItemRow["match_kind"] {
  if (String(row.fnsku ?? "").trim()) return "fnsku";
  if (String(row.sku ?? "").trim()) return "upc";
  return "unexpected";
}

/**
 * List scanned units for a package from `return_items`, matched to slip lines by barcode.
 */
export async function listOperatorPackageItemsForPackageAction(
  requestedOrganizationId: string,
  packageId: string,
  storeId?: string | null,
): Promise<{ ok: true; rows: OperatorPackageItemRow[] } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const pkgId = String(packageId ?? "").trim();
  if (!isUuidString(pkgId)) {
    return { ok: false, message: "Invalid package id." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const { data: pkgRow, error: pkgSelErr } = await supabaseServer
    .from("packages")
    .select("id, store_id")
    .eq("id", pkgId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgSelErr) return { ok: false, message: pkgSelErr.message };
  if (!pkgRow) {
    return { ok: false, message: "Package not found for this organization." };
  }
  const scope = String(storeId ?? "").trim();
  const pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  if (scope && isUuidString(scope) && pkgStore && isUuidString(pkgStore) && pkgStore !== scope) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  const slipRes = await listOperatorSlipContentsForPackageAction(
    requestedOrganizationId,
    pkgId,
    storeId ?? null,
  );
  const slipMatchRows: SlipBarcodeMatchRow[] = slipRes.ok
    ? slipRes.rows.map((s) => ({
        id: s.id,
        upc: s.upc,
        fnsku: s.fnsku,
        description: s.description,
        quantity: s.quantity,
        sort_index: s.sort_index,
      }))
    : [];

  const returnItemSelectAttempts = [
    `id, fnsku, sku, product_identifier, item_name, conditions, expiration_date, batch_number, photo_evidence, notes, created_at, updated_at, created_by, updated_by, ${RETURN_SCANNER_LINKAGE_SELECT}`,
    "id, fnsku, sku, product_identifier, item_name, conditions, expiration_date, batch_number, photo_evidence, notes, created_at, updated_at, created_by, updated_by",
    "id, fnsku, sku, product_identifier, item_name, conditions, expiration_date, batch_number, photo_evidence, notes, created_at, created_by, updated_by",
    `id, fnsku, sku, product_identifier, item_name, conditions, expiration_date, batch_number, photo_evidence, notes, created_at, ${RETURN_SCANNER_LINKAGE_SELECT}`,
    "id, fnsku, sku, product_identifier, item_name, conditions, expiration_date, batch_number, photo_evidence, notes, created_at",
    "id, fnsku, sku, product_identifier, item_name, conditions, expiration_date, batch_number, photo_evidence, created_at",
  ];

  let returnRes: { data: unknown; error: { message: string } | null } | null = null;
  for (const sel of returnItemSelectAttempts) {
    const r = await supabaseServer
      .from(RETURN_ITEMS_TABLE)
      .select(sel)
      .eq("package_id", pkgId)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    returnRes = r;
    if (!r.error) break;
  }
  if (!returnRes || returnRes.error) {
    return { ok: false, message: returnRes?.error?.message ?? "return_items load failed." };
  }

  const raw = Array.isArray(returnRes.data) ? returnRes.data : [];
  const realReturnRows = raw.filter((r: unknown) => {
    const row = r as Record<string, unknown>;
    return !shouldExcludeReturnItemFromScannerCounts({
      item_name: typeof row.item_name === "string" ? row.item_name : null,
      sku: typeof row.sku === "string" ? row.sku : null,
      fnsku: typeof row.fnsku === "string" ? row.fnsku : null,
      product_identifier: typeof row.product_identifier === "string" ? row.product_identifier : null,
      notes: typeof row.notes === "string" ? row.notes : null,
    });
  });
  const stubs: {
    id: string;
    slip_content_id: string | null;
    scanned_barcode: string;
    match_kind: OperatorPackageItemRow["match_kind"];
    quantity: number;
    discrepancy_tags: string[] | null;
    expiry_date: string | null;
    lot_number: string | null;
    evidence_urls: string[] | null;
    expiry_evidence_urls: string[] | null;
    optional_item_photo_url: string | null;
    optional_item_photo_urls: string[] | null;
    operator_notes: string | null;
    created_at: string | null;
    updated_at: string | null;
    created_by: string | null;
    updated_by: string | null;
    resolved_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
    item_name: string | null;
    fnsku: string | null;
    sku: string | null;
    product_identifier: string | null;
  }[] = realReturnRows.map((r: unknown) => {
    const row = r as Record<string, unknown>;
    const id = typeof row.id === "string" && isUuidString(row.id.trim()) ? row.id.trim() : "";
    const fnsku = typeof row.fnsku === "string" ? row.fnsku : null;
    const sku = typeof row.sku === "string" ? row.sku : null;
    const product_identifier = typeof row.product_identifier === "string" ? row.product_identifier : null;
    const scanned_barcode = scannedBarcodeFromReturnItemRow({ fnsku, sku, product_identifier });
    const operator_notes =
      typeof row.notes === "string" && row.notes.trim() ? row.notes.trim().slice(0, 2000) : null;
    const slip_content_id = returnItemNotesMarkOffSlip(operator_notes)
      ? null
      : slipContentIdForReturnItemBarcode(scanned_barcode, slipMatchRows);
    const match_kind = inferMatchKindFromReturnItemRow({ fnsku, sku, product_identifier });
    const dt = Array.isArray(row.conditions)
      ? row.conditions.map((x) => String(x ?? "").trim()).filter(Boolean)
      : null;
    const pe = (row.photo_evidence ?? null) as ReturnPhotoEvidenceRow;
    const hasExpiredTag = (dt ?? []).includes("expired");
    const splitPhotos = splitOperatorItemUnitPhotos(pe, { hasExpiredTag });
    const exp =
      row.expiration_date === null || row.expiration_date === undefined
        ? null
        : String(row.expiration_date).trim().slice(0, 32) || null;
    const lot = typeof row.batch_number === "string" ? row.batch_number.trim().slice(0, 500) : null;
    const resolvedRaw =
      typeof row.resolved_product_id === "string" && isUuidString(row.resolved_product_id.trim())
        ? row.resolved_product_id.trim()
        : null;
    return {
      id,
      slip_content_id,
      scanned_barcode,
      match_kind,
      quantity: 1,
      discrepancy_tags: dt?.length ? dt : null,
      expiry_date: exp,
      lot_number: lot?.length ? lot : null,
      evidence_urls: splitPhotos.evidenceUrls.length ? splitPhotos.evidenceUrls : null,
      expiry_evidence_urls: splitPhotos.expiryEvidenceUrls.length ? splitPhotos.expiryEvidenceUrls : null,
      optional_item_photo_url: splitPhotos.optionalItemPhotoUrl,
      optional_item_photo_urls: splitPhotos.optionalItemPhotoUrls.length
        ? splitPhotos.optionalItemPhotoUrls
        : null,
      operator_notes,
      created_at:
        typeof row.created_at === "string" && row.created_at.trim() ? row.created_at.trim() : null,
      updated_at:
        typeof row.updated_at === "string" && row.updated_at.trim() ? row.updated_at.trim() : null,
      created_by:
        typeof row.created_by === "string" && row.created_by.trim() ? row.created_by.trim() : null,
      updated_by:
        typeof row.updated_by === "string" && row.updated_by.trim() ? row.updated_by.trim() : null,
      resolved_product_id: resolvedRaw,
      identifier_resolution_status:
        typeof row.identifier_resolution_status === "string" ? row.identifier_resolution_status : null,
      identifier_resolution_confidence: (() => {
        const n = Number(row.identifier_resolution_confidence);
        return Number.isFinite(n) ? n : null;
      })(),
      item_name: typeof row.item_name === "string" ? row.item_name : null,
      fnsku,
      sku,
      product_identifier,
    };
  });

  const slipLinkageById = new Map<string, ProductLinkageDisplayContract>();
  if (slipRes.ok) {
    for (const slip of slipRes.rows) {
      const sid = slip.id?.trim();
      if (sid && isUuidString(sid)) slipLinkageById.set(sid, slip.product_linkage);
    }
  }

  const productIds = stubs
    .flatMap((s) => {
      const slipLink = s.slip_content_id ? slipLinkageById.get(s.slip_content_id) : undefined;
      return [s.resolved_product_id, slipLink?.resolved_product_id ?? null];
    })
    .filter((id): id is string => Boolean(id));
  const productNameById = await fetchProductNamesByResolvedIds(
    supabaseServer as unknown as ProductsLookupClient,
    productIds,
  );

  const rows: OperatorPackageItemRow[] = stubs.map((stub) => {
    const {
      resolved_product_id: riResolvedId,
      identifier_resolution_status: riStatus,
      identifier_resolution_confidence: riConfidence,
      item_name,
      fnsku,
      sku,
      product_identifier,
      slip_content_id,
      ...rest
    } = stub;
    const slipLink = slip_content_id ? slipLinkageById.get(slip_content_id) : undefined;
    const resolved_product_id = riResolvedId ?? slipLink?.resolved_product_id ?? null;
    const identifier_resolution_status = riResolvedId
      ? riStatus
      : (slipLink?.identifier_resolution_status ?? riStatus);
    const identifier_resolution_confidence = riResolvedId
      ? riConfidence
      : (slipLink?.identifier_resolution_confidence ?? riConfidence);
    return {
      ...rest,
      slip_content_id,
      fnsku: fnsku?.trim() ? fnsku.trim() : null,
      sku: sku?.trim() ? sku.trim() : null,
      product_identifier: product_identifier?.trim() ? product_identifier.trim() : null,
      created_by_display: null,
      updated_by_display: null,
      product_linkage: buildProductLinkageDisplayContract(
        {
          resolved_product_id,
          identifier_resolution_status,
          identifier_resolution_confidence,
          item_name,
          fnsku,
          sku,
          product_identifier,
          description: slipLink?.fallback_display_name ?? null,
        },
        productNameById,
      ),
    };
  });

  const filtered = rows.filter((r) => r.id);
  const enriched = await enrichOperatorPackageItemRowsWithAuditLabels(filtered);
  return { ok: true, rows: enriched };
}

export type InsertOperatorPackageItemInput = {
  requestedOrganizationId: string;
  /** Required for boxed units; omit when `looseItem` is true. */
  packageId?: string | null;
  storeId: string | null;
  slipContentId: string | null;
  scannedBarcode: string;
  matchKind: "fnsku" | "upc" | "unexpected";
  quantity?: number;
  discrepancyTags?: string[] | null;
  expiryDate?: string | null;
  lotNumber?: string | null;
  evidenceUrls?: string[] | null;
  /** Expiry label photos (`photo_evidence.expiry_url`). */
  expiryEvidenceUrls?: string[] | null;
  /** Optional item photos (stored in `photo_evidence.item_url` + `item_urls`). */
  optionalItemPhotoUrls?: string[] | null;
  /** Legacy single optional photo — merged into `optionalItemPhotoUrls`. */
  optionalItemPhotoUrl?: string | null;
  /** When true, expiry date + lot # are required (perishable / grocery path). */
  traceabilityRequired?: boolean;
  /** Operator prose note (`return_items.notes`). */
  operatorNotes?: string | null;
  /** Client/server hint — parent `expected_packages.id` with remaining qty (Item Scan slip row). */
  expectedPackageHintId?: string | null;
  /**
   * When true, save without expected allocation and mark the unit off-slip
   * (`return_items.notes` audit marker; no slip line link in Item Scan counts).
   */
  saveAsOffSlip?: boolean;
  /** Loose item (no box) — writes `return_items` without `package_id`. */
  looseItem?: boolean;
  /** Step 2 fallback — return label on packaging (loose flow). */
  returnLabelPhotoUrl?: string | null;
};

/** Operator missing review is metadata only; physical items live in `return_items`. */
function isPackageLevelShortageTagBlocked(tags: readonly unknown[]): boolean {
  return tags.some((t) => String(t ?? "").trim() === "missing_item");
}

function rejectPackageLevelMissingItemTag(
  tags: ItemUnitDiscrepancyTagKey[],
): { ok: true } | { ok: false; message: string } {
  if (tags.includes("missing_item")) {
    return {
      ok: false,
      message:
        "Missing expected units are recorded as package manifest metadata — not as scanned return_items.",
    };
  }
  return { ok: true };
}

function normalizeEvidenceUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const u of raw) {
    const s = String(u ?? "").trim().slice(0, 2000);
    if (s && /^https?:\/\//i.test(s) && out.length < 3) out.push(s);
  }
  return out;
}

function normalizeOptionalItemPhotoUrls(
  urls: unknown,
  legacySingle?: string | null | undefined,
): string[] {
  const merged = normalizeEvidenceUrls(urls);
  const legacy = String(legacySingle ?? "").trim();
  if (legacy && /^https?:\/\//i.test(legacy) && !merged.includes(legacy)) {
    return normalizeEvidenceUrls([legacy, ...merged]);
  }
  return merged;
}

function normalizeOptionalDate(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

type SlipLinkageInheritRow = {
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
};

async function tryPromoteScannerClaimForReturnItem(
  returnItemId: string,
  organizationId: string,
  actorProfileId: string | null,
): Promise<void> {
  try {
    const res = await promoteScannerReturnItemToClaimStructures(returnItemId, {
      organizationId,
      actorProfileId,
    });
    if (
      !res.promoted &&
      res.skipped_reason &&
      !isExpectedScannerClaimPromoteSkipReason(res.skipped_reason)
    ) {
      console.warn("[scanner claim promote]", returnItemId, res.skipped_reason);
    }
  } catch (err) {
    console.warn("[scanner claim promote] failed:", returnItemId, err);
  }
}

/** Mirrors `operatorReceiveItem` rollback when expected allocation fails after insert. */
async function rollbackOperatorPackageReturnItemsOnAllocationFailure(
  returnItemIds: string[],
): Promise<void> {
  for (const id of returnItemIds) {
    const rid = String(id ?? "").trim();
    if (!isUuidString(rid)) continue;
    await supabaseServer.from(RETURN_ITEMS_TABLE).delete().eq("id", rid);
  }
}

async function finalizeOperatorPackageItemLinkage(
  returnItemId: string,
  params: {
    organizationId: string;
    storeId: string;
    packageId: string | null;
    looseItem: boolean;
    slipLinkage: SlipLinkageInheritRow | null;
    scanIds: { asin?: string | null; fnsku?: string | null; sku?: string | null; upc?: string | null };
    slipContentId?: string | null;
    slipExpectedQuantity?: number | null;
    expectedPackageHintId?: string | null;
    packageSlipCode?: string | null;
    packageTrackingNumber?: string | null;
    orderId?: string | null;
    disposition?: string | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rid = String(returnItemId ?? "").trim();
  if (!isUuidString(rid)) return { ok: true };

  await applyReturnItemProductEnrichmentAfterInsert(supabaseServer, {
    returnItemId: rid,
    organizationId: params.organizationId,
    storeId: params.storeId,
    asin: params.scanIds.asin,
    fnsku: params.scanIds.fnsku,
    sku: params.scanIds.sku,
    upc: params.scanIds.upc,
  });

  const slipPid = params.slipLinkage?.resolved_product_id?.trim();
  if (slipPid && isUuidString(slipPid)) {
    const { linkage } = await hydrateReturnItemProductLinkage(supabaseServer, rid, params.organizationId);
    const currentPid = linkage?.resolved_product_id?.trim();
    if (!currentPid) {
      const slipStatus = String(params.slipLinkage?.identifier_resolution_status ?? "").trim().toLowerCase();
      await updateRowWithScannerLinkagePatch(supabaseServer, RETURN_ITEMS_TABLE, rid, {
        resolved_product_id: slipPid,
        product_id: slipPid,
        resolved_catalog_product_id: params.slipLinkage?.resolved_catalog_product_id ?? null,
        identifier_resolution_status: slipStatus === "ambiguous" ? "ambiguous" : "resolved",
        identifier_resolution_confidence: params.slipLinkage?.identifier_resolution_confidence ?? null,
        identifier_resolution_source: "slip_contents_inherit",
      });
    }
  }

  if (!params.looseItem && params.packageId && isUuidString(params.packageId)) {
    const pkgCtx = await fetchPackageReceiveContext(supabaseServer, params.packageId);
    const receiveScopeKey = buildReceiveScopeKey({
      organizationId: params.organizationId,
      storeId: params.storeId,
      packageId: params.packageId,
      slipCode: pkgCtx.slipCode,
    });
    const allocFnsku = String(params.scanIds.fnsku ?? "").trim();
    const allocSku = String(params.scanIds.sku ?? params.scanIds.upc ?? "").trim();
    const slipCode = params.packageSlipCode ?? pkgCtx.slipCode;
    const trackingNumber = params.packageTrackingNumber ?? pkgCtx.trackingNumber;

    let expectedHint = String(params.expectedPackageHintId ?? "").trim();
    if (!expectedHint || !isUuidString(expectedHint)) {
      try {
        expectedHint =
          (await resolveAllocatableExpectedPackageHint(supabaseServer, {
            organizationId: params.organizationId,
            storeId: params.storeId,
            fnsku: allocFnsku,
            sku: allocSku,
            upc: params.scanIds.upc,
            orderId: params.orderId,
            disposition: params.disposition,
            packageSlipCode: slipCode,
            packageTrackingNumber: trackingNumber,
            preferredHintId: params.expectedPackageHintId,
          })) ?? "";
      } catch (e) {
        return {
          ok: false,
          error: humanizeExpectedAllocationError(
            e instanceof Error ? e.message : "Expected row lookup failed.",
            { fnsku: allocFnsku, sku: allocSku, slipCode, trackingNumber },
          ),
        };
      }
    }

    const slipId = String(params.slipContentId ?? "").trim();
    const slipExpected = Math.max(0, Math.floor(Number(params.slipExpectedQuantity ?? 0)));
    if (!expectedHint && slipId && isUuidString(slipId) && slipExpected > 0) {
      return { ok: true };
    }

    if (!expectedHint) {
      return { ok: true };
    }

    const alloc = await allocateExpectedItemsForReturnItemIds(supabaseServer, {
      returnItemIds: [rid],
      receiveScopeKey,
      expectedPackageHintId: expectedHint && isUuidString(expectedHint) ? expectedHint : null,
      errorContext: { fnsku: allocFnsku, sku: allocSku, slipCode, trackingNumber },
    });
    if (!alloc.ok) {
      if (isNoAllocatableExpectedAllocationError(alloc.error)) {
        return { ok: true };
      }
      return { ok: false, error: alloc.error };
    }
  }
  return { ok: true };
}

export type PreviewOperatorItemBarcodeLinkageInput = {
  requestedOrganizationId: string;
  storeId: string;
  scannedBarcode: string;
  matchKind?: "fnsku" | "upc" | "unexpected";
};

export type PreviewOperatorSlipLineIdentifiersLinkageInput = {
  requestedOrganizationId: string;
  storeId: string;
  lines: Array<{
    upc?: string | null;
    fnsku?: string | null;
    printed_asin?: string | null;
  }>;
};

/**
 * Dry-run resolver for BOX slip vision lines (identifiers only — no slip_contents write).
 */
export async function previewOperatorSlipLinesIdentifiersLinkageAction(
  input: PreviewOperatorSlipLineIdentifiersLinkageInput,
): Promise<
  { ok: true; linkages: ProductLinkageDisplayContract[] } | { ok: false; message: string }
> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, message: "Store is required." };
  }

  const linesIn = Array.isArray(input.lines) ? input.lines : [];
  try {
    const linkages: ProductLinkageDisplayContract[] = [];
    const resolvedIds: string[] = [];

    for (const line of linesIn) {
      const ids = slipVisionLineIdentifierFields(line);
      const hasIdentifier = Boolean(ids.resolverFnsku || ids.resolverAsin || ids.resolverUpc);
      if (!hasIdentifier) {
        linkages.push(
          buildProductLinkageDisplayContract(
            { fnsku: ids.parsed_fnsku, upc: ids.parsed_upc },
            new Map(),
          ),
        );
        continue;
      }

      const res = await resolveProductForScannerItem(supabaseServer, {
        organization_id: organizationId,
        store_id: storeId,
        fnsku: ids.resolverFnsku,
        asin: ids.resolverAsin,
        upc: ids.resolverUpc,
        source_table: "slip_contents",
      });
      if (res.resolved_product_id) resolvedIds.push(res.resolved_product_id);
      linkages.push(
        buildProductLinkageFromResolveResult(
          { fnsku: ids.parsed_fnsku, upc: ids.parsed_upc, item_name: null },
          res,
          new Map(),
        ),
      );
    }

    if (resolvedIds.length > 0) {
      const productNameById = await fetchProductNamesByResolvedIds(
        supabaseServer as unknown as ProductsLookupClient,
        resolvedIds,
      );
      for (let i = 0; i < linkages.length; i++) {
        const lid = linkages[i]?.resolved_product_id;
        if (lid && productNameById.has(lid)) {
          linkages[i] = {
            ...linkages[i]!,
            product_name: productNameById.get(lid) ?? linkages[i]!.product_name,
          };
        }
      }
    }

    return { ok: true, linkages };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Slip line resolver preview failed." };
  }
}

export type OperatorProductDetailRow = {
  id: string;
  product_name: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  barcode: string | null;
  store_id: string | null;
};

export type OperatorProductSearchRow = {
  id: string;
  label: string;
  sku: string | null;
  product_name: string | null;
};

/**
 * Read-only catalog product detail for operator linkage drill-down (by `products.id`).
 */
export async function fetchOperatorProductDetailAction(
  productId: string,
  requestedOrganizationId: string | null | undefined,
): Promise<{ ok: true; product: OperatorProductDetailRow } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const pid = String(productId ?? "").trim();
  if (!isUuidString(pid)) {
    return { ok: false, message: "Invalid product id." };
  }

  try {
    let res = await supabaseServer
      .from("products")
      .select("id, product_name, name, sku, fnsku, asin, barcode, store_id")
      .eq("id", pid)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (res.error) {
      res = await supabaseServer
        .from("products")
        .select("id, name, sku, fnsku, asin, barcode, store_id")
        .eq("id", pid)
        .eq("organization_id", organizationId)
        .maybeSingle();
    }
    if (res.error) return { ok: false, message: res.error.message };
    if (!res.data || typeof res.data !== "object") {
      return { ok: false, message: "Product not found." };
    }
    const r = res.data as Record<string, unknown>;
    return {
      ok: true,
      product: {
        id: pid,
        product_name: String(r.product_name ?? r.name ?? "").trim() || null,
        sku: String(r.sku ?? "").trim() || null,
        fnsku: String(r.fnsku ?? "").trim() || null,
        asin: String(r.asin ?? "").trim() || null,
        barcode: String(r.barcode ?? "").trim() || null,
        store_id: String(r.store_id ?? "").trim() || null,
      },
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Product load failed." };
  }
}

/**
 * Read-only product search for manual linkage override (org + store scoped).
 */
export async function searchOperatorProductsForStoreAction(input: {
  requestedOrganizationId: string;
  storeId: string;
  query: string;
  limit?: number;
}): Promise<{ ok: true; rows: OperatorProductSearchRow[] } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, message: "Store is required." };
  }
  const q = String(input.query ?? "").trim();
  if (q.length < 2) {
    return { ok: true, rows: [] };
  }
  const limit = Math.min(20, Math.max(1, Math.floor(Number(input.limit) || 20)));

  try {
    const classified = classifyCatalogSearchQuery(q);
    let data: unknown = null;
    let error: { message: string } | null = null;

    if (isIdentifierCatalogQuery(classified.kind)) {
      const v = classified.normalized;
      const col =
        classified.kind === "upc"
          ? "upc_code"
          : classified.kind === "sku"
            ? "sku"
            : classified.kind === "fnsku"
              ? "fnsku"
              : "asin";
      const primary = await supabaseServer
        .from("products")
        .select("id, product_name, name, sku, fnsku, asin")
        .eq("organization_id", organizationId)
        .eq("store_id", storeId)
        .eq(col, v)
        .limit(limit);
      data = primary.data;
      error = primary.error;
    } else {
      const pattern = catalogIlikePattern(q);
      const primary = await supabaseServer
        .from("products")
        .select("id, product_name, name, sku, fnsku, asin")
        .eq("organization_id", organizationId)
        .eq("store_id", storeId)
        .or(`product_name.ilike.${pattern},name.ilike.${pattern}`)
        .limit(limit);
      data = primary.data;
      error = primary.error;
      if (error) {
        const fallback = await supabaseServer
          .from("products")
          .select("id, name, sku, fnsku, asin")
          .eq("organization_id", organizationId)
          .eq("store_id", storeId)
          .or(`name.ilike.${pattern},product_name.ilike.${pattern}`)
          .limit(limit);
        data = fallback.data;
        error = fallback.error;
      }
    }
    if (error) return { ok: false, message: error.message };
    const rows: OperatorProductSearchRow[] = [];
    for (const raw of Array.isArray(data) ? data : []) {
      const r = raw as Record<string, unknown>;
      const id = String(r.id ?? "").trim();
      if (!isUuidString(id)) continue;
      const product_name = String(r.product_name ?? r.name ?? "").trim() || null;
      const sku = String(r.sku ?? "").trim() || null;
      const fnsku = String(r.fnsku ?? "").trim() || null;
      const asin = String(r.asin ?? "").trim() || null;
      const label = [product_name, sku, fnsku, asin].filter(Boolean).join(" · ") || id.slice(0, 8);
      rows.push({ id, label, sku, product_name });
    }
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Product search failed." };
  }
}

/**
 * Dry-run resolver for operator item add/edit barcode fields — no `return_items` write.
 */
export async function previewOperatorItemBarcodeLinkageAction(
  input: PreviewOperatorItemBarcodeLinkageInput,
): Promise<
  { ok: true; product_linkage: ProductLinkageDisplayContract } | { ok: false; message: string }
> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, message: "Store is required." };
  }
  const barcode = String(input.scannedBarcode ?? "").trim();
  if (!barcode) {
    return { ok: false, message: "Barcode is required." };
  }

  const fields = buildOperatorBarcodeResolverFields(barcode);

  try {
    const res = await resolveProductForScannerItem(supabaseServer, {
      organization_id: organizationId,
      store_id: storeId,
      fnsku: fields.fnsku,
      asin: fields.asin,
      sku: fields.sku,
      msku: fields.sku,
      upc: fields.upc,
      source_table: RETURN_ITEMS_TABLE,
    });
    const productNameById = await fetchProductNamesByResolvedIds(
      supabaseServer as unknown as ProductsLookupClient,
      res.resolved_product_id ? [res.resolved_product_id] : [],
    );
    const product_linkage = buildProductLinkageFromResolveResult(
      { fnsku: fields.fnsku, sku: fields.sku, item_name: null },
      res,
      productNameById,
    );
    return { ok: true, product_linkage };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Resolver preview failed." };
  }
}

/**
 * Insert one scan batch as a single `return_items` row (`scanned_quantity` = unit count;
 * `packages.actual_item_count` via DB trigger).
 */
export async function insertOperatorPackageItemAction(
  input: InsertOperatorPackageItemInput,
): Promise<
  | { ok: true; id: string; product_linkage: ProductLinkageDisplayContract }
  | { ok: false; message: string }
> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const looseItem = Boolean(input.looseItem);
  const pkgIdRaw = String(input.packageId ?? "").trim();
  const pkgId = isUuidString(pkgIdRaw) ? pkgIdRaw : null;
  if (!looseItem && !pkgId) {
    return { ok: false, message: "Invalid package id." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const barcode = String(input.scannedBarcode ?? "").trim();
  if (!barcode) {
    return { ok: false, message: "Barcode is required." };
  }

  const qtyRaw = Number(input.quantity ?? 1);
  const quantity = Number.isFinite(qtyRaw) ? Math.max(1, Math.min(500, Math.floor(qtyRaw))) : 1;

  let pkgStore = "";
  if (!looseItem && pkgId) {
    const { data: pkgRow, error: pkgSelErr } = await supabaseServer
      .from("packages")
      .select("id, store_id, organization_id")
      .eq("id", pkgId)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (pkgSelErr) return { ok: false, message: pkgSelErr.message };
    if (!pkgRow) {
      return { ok: false, message: "Package not found for this organization." };
    }

    const receiveGate = await assertPackageReceiveOpenForPackageEdits(organizationId, pkgId);
    if (!receiveGate.ok) return { ok: false, message: receiveGate.message };

    const pkgOrg = String((pkgRow as { organization_id?: string | null }).organization_id ?? "").trim();
    if (pkgOrg && isUuidString(pkgOrg) && pkgOrg !== organizationId) {
      return { ok: false, message: "Package organization mismatch." };
    }
    pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  }

  const scope = String(input.storeId ?? "").trim();
  const storeIdResolved =
    scope && isUuidString(scope) ? scope : pkgStore && isUuidString(pkgStore) ? pkgStore : null;
  if (
    !looseItem &&
    scope &&
    isUuidString(scope) &&
    pkgStore &&
    isUuidString(pkgStore) &&
    pkgStore !== scope
  ) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  const slipHint = String(input.slipContentId ?? "").trim();
  let slipDescription: string | null = null;
  let slipLinkageInherit: SlipLinkageInheritRow | null = null;
  let slipFnsku: string | null = null;
  let slipUpc: string | null = null;
  let slipExpectedQuantity: number | null = null;
  let slipOrderId: string | null = null;
  if (slipHint && isUuidString(slipHint)) {
    if (looseItem) {
      return { ok: false, message: "Slip line cannot be used for a loose item scan." };
    }
    const slipSelectAttempts = [
      `id, package_id, description, fnsku, upc, ${RETURN_SCANNER_LINKAGE_SELECT}`,
      "id, package_id, description, fnsku, upc",
      "id, package_id, description",
    ];
    let slipRow: Record<string, unknown> | null = null;
    let slipErr: { message: string } | null = null;
    for (const sel of slipSelectAttempts) {
      const r = await supabaseServer
        .from("slip_contents")
        .select(sel)
        .eq("id", slipHint)
        .eq("organization_id", organizationId)
        .maybeSingle();
      slipErr = r.error;
      if (!r.error && r.data && typeof r.data === "object") {
        slipRow = r.data as Record<string, unknown>;
        break;
      }
      if (r.error && !r.error.message.toLowerCase().includes("column")) break;
    }
    if (slipErr && !slipRow) return { ok: false, message: slipErr.message };
    const spkg = String(slipRow?.package_id ?? "").trim();
    if (!slipRow || !pkgId || spkg !== pkgId) {
      return { ok: false, message: "Slip line does not belong to this package." };
    }
    slipDescription =
      typeof slipRow.description === "string" ? slipRow.description.trim() : null;
    slipFnsku = typeof slipRow.fnsku === "string" ? slipRow.fnsku.trim() || null : null;
    slipUpc = typeof slipRow.upc === "string" ? slipRow.upc.trim() || null : null;
    slipExpectedQuantity = Math.max(0, Math.floor(Number(slipRow.quantity ?? 0)));
    slipOrderId = typeof slipRow.order_id === "string" ? slipRow.order_id.trim() || null : null;
    const slipResolved =
      typeof slipRow.resolved_product_id === "string" && isUuidString(slipRow.resolved_product_id.trim())
        ? slipRow.resolved_product_id.trim()
        : null;
    const slipCatalog =
      typeof slipRow.resolved_catalog_product_id === "string" &&
      isUuidString(slipRow.resolved_catalog_product_id.trim())
        ? slipRow.resolved_catalog_product_id.trim()
        : null;
    slipLinkageInherit = {
      resolved_product_id: slipResolved,
      resolved_catalog_product_id: slipCatalog,
      identifier_resolution_status:
        typeof slipRow.identifier_resolution_status === "string"
          ? slipRow.identifier_resolution_status
          : null,
      identifier_resolution_confidence: (() => {
        const n = Number(slipRow?.identifier_resolution_confidence);
        return Number.isFinite(n) ? n : null;
      })(),
    };
  } else if (slipHint) {
    return { ok: false, message: "Invalid slip line id." };
  }

  const tags = filterPackageItemDiscrepancyTags(input.discrepancyTags);
  if (isPackageLevelShortageTagBlocked(input.discrepancyTags ?? [])) {
    return {
      ok: false,
      message:
        "Missing/shortage is recorded at box finalize — scan received units or mark empty box when closing the package.",
    };
  }
  if (tags.length === 0) {
    return { ok: false, message: "Select at least one condition for this unit." };
  }
  const missingItemReject = rejectPackageLevelMissingItemTag(tags);
  if (!missingItemReject.ok) return missingItemReject;

  const evidence = normalizeEvidenceUrls(input.evidenceUrls);
  if (packageItemRequiresEvidencePhotos(tags) && evidence.length === 0) {
    return { ok: false, message: "Add at least one evidence photo for the selected issue(s)." };
  }

  const exp = normalizeOptionalDate(input.expiryDate ?? null);
  const lotRaw = String(input.lotNumber ?? "").trim();
  const lot = lotRaw ? lotRaw.slice(0, 500) : null;

  const traceabilityRequired = Boolean(input.traceabilityRequired);
  if (traceabilityRequired && !exp) {
    return { ok: false, message: "Expiration date is required for this item." };
  }

  if (!storeIdResolved || !isUuidString(storeIdResolved)) {
    return { ok: false, message: "Store is required to save item scans." };
  }

  const itemName = (slipDescription || "Scanned unit").slice(0, 500);
  const optionalItemPhotoUrls = normalizeOptionalItemPhotoUrls(
    input.optionalItemPhotoUrls,
    input.optionalItemPhotoUrl,
  );
  const returnLabelUrl = String(input.returnLabelPhotoUrl ?? "").trim();
  const expiryEvidence = normalizeEvidenceUrls(input.expiryEvidenceUrls);
  const hasExpiredTag = tags.includes("expired");
  if (hasExpiredTag && expiryEvidence.length === 0) {
    return { ok: false, message: "Expiry photo is required when Expired is selected." };
  }
  let photo_evidence = buildOperatorItemUnitPhotoEvidence({
    evidenceUrls: evidence,
    expiryEvidenceUrls: expiryEvidence,
    optionalItemPhotoUrls,
  });
  if (returnLabelUrl && /^https?:\/\//i.test(returnLabelUrl)) {
    photo_evidence = { ...(photo_evidence ?? {}), return_label_url: returnLabelUrl };
  }

  const saveAsOffSlip = Boolean(input.saveAsOffSlip);
  const operatorNotesRaw = String(input.operatorNotes ?? "").trim().slice(0, 2000) || null;
  const operatorNotes = saveAsOffSlip ? appendOffSlipAuditNote(operatorNotesRaw) : operatorNotesRaw;

  const scanIds = buildOperatorBarcodeResolverFields(barcode);
  const persistFnsku = (scanIds.fnsku ?? slipFnsku ?? "").trim().slice(0, 500) || undefined;
  const persistSku = (scanIds.sku ?? slipUpc ?? "").trim().slice(0, 500) || undefined;
  const persistUpc = (scanIds.upc ?? slipUpc ?? "").trim().slice(0, 500) || undefined;

  let packageSlipCode: string | null = null;
  let packageTrackingNumber: string | null = null;
  if (!looseItem && pkgId) {
    const pkgCtx = await fetchPackageReceiveContext(supabaseServer, pkgId);
    packageSlipCode = pkgCtx.slipCode;
    packageTrackingNumber = pkgCtx.trackingNumber;
  }

  let expectedPackageHintId = String(input.expectedPackageHintId ?? "").trim();
  if (
    !saveAsOffSlip &&
    !looseItem &&
    pkgId &&
    (!expectedPackageHintId || !isUuidString(expectedPackageHintId))
  ) {
    try {
      const resolved = await resolveAllocatableExpectedPackageHint(supabaseServer, {
        organizationId,
        storeId: storeIdResolved,
        fnsku: persistFnsku ?? slipFnsku,
        sku: persistSku ?? slipUpc,
        upc: persistUpc,
        orderId: slipOrderId,
        packageSlipCode,
        packageTrackingNumber,
        preferredHintId: input.expectedPackageHintId,
      });
      if (resolved) expectedPackageHintId = resolved;
    } catch (e) {
      return {
        ok: false,
        message: humanizeExpectedAllocationError(
          e instanceof Error ? e.message : "Expected row lookup failed.",
          {
            fnsku: persistFnsku ?? slipFnsku,
            sku: persistSku ?? slipUpc,
            slipCode: packageSlipCode,
            trackingNumber: packageTrackingNumber,
          },
        ),
      };
    }
  }
  if (saveAsOffSlip) {
    expectedPackageHintId = "";
  }

  const insertReturnBase = {
    organization_id: organizationId,
    store_id: storeIdResolved,
    marketplace: "amazon" as const,
    item_name: itemName,
    conditions: [...tags],
    notes: operatorNotes ?? undefined,
    expiration_date: exp ?? undefined,
    batch_number: lot ?? undefined,
    photo_evidence,
    actor_profile_id: sessionUserId,
  };

  const ins = await insertReturn({
    ...insertReturnBase,
    package_id: looseItem ? undefined : pkgId ?? undefined,
    fnsku: persistFnsku,
    sku: persistSku,
    asin: scanIds.asin?.slice(0, 500),
    product_identifier: persistUpc,
    order_id: slipOrderId ?? undefined,
    scanned_quantity: quantity,
  });

  if (!ins.ok || !ins.data?.id) {
    const guarded = guardBatchQuantityBackendError(quantity, ins.error);
    return {
      ok: false,
      message: guarded ?? ins.error ?? "Failed to save item scan.",
    };
  }

  const primaryId = ins.data.id;
  const insertedIds: string[] = [primaryId];

  const finalizeLinkageParams = {
    organizationId,
    storeId: storeIdResolved,
    packageId: looseItem ? null : pkgId,
    looseItem,
    slipLinkage: slipLinkageInherit,
    slipContentId:
      saveAsOffSlip || !slipHint || !isUuidString(slipHint) ? null : slipHint,
    slipExpectedQuantity: saveAsOffSlip ? 0 : slipExpectedQuantity,
    expectedPackageHintId:
      saveAsOffSlip || !isUuidString(expectedPackageHintId) ? null : expectedPackageHintId,
    packageSlipCode,
    packageTrackingNumber,
    orderId: slipOrderId,
    disposition: null as string | null,
    scanIds: {
      asin: scanIds.asin ?? null,
      fnsku: persistFnsku ?? null,
      sku: persistSku ?? null,
      upc: persistUpc ?? null,
    },
  };

  const finalizePrimary = await finalizeOperatorPackageItemLinkage(primaryId, finalizeLinkageParams);
  if (!finalizePrimary.ok) {
    await rollbackOperatorPackageReturnItemsOnAllocationFailure(insertedIds);
    return { ok: false, message: finalizePrimary.error };
  }
  await tryPromoteScannerClaimForReturnItem(primaryId, organizationId, sessionUserId);

  const { linkage } = await hydrateReturnItemProductLinkage(supabaseServer, primaryId, organizationId);
  const product_linkage =
    linkage ??
    buildProductLinkageDisplayContract(
      {
        fnsku: scanIds.fnsku ?? null,
        sku: scanIds.sku ?? null,
        product_identifier: scanIds.upc ?? null,
        item_name: itemName,
      },
      new Map(),
    );

  return { ok: true, id: primaryId, product_linkage };
}

export type InsertOperatorPackageItemBatchInput = InsertOperatorPackageItemInput & {
  batchQuantity: number;
  batchAllocation: ItemBatchAllocationInput;
};

/**
 * Batch item-scan save: creates N normal `return_items` rows with per-unit expected/off-slip allocation.
 */
export async function insertOperatorPackageItemBatchAction(
  input: InsertOperatorPackageItemBatchInput,
): Promise<
  | { ok: true; ids: string[]; product_linkage: ProductLinkageDisplayContract; offSlipCount: number }
  | { ok: false; message: string }
> {
  const batchQtyRaw = Number(input.batchQuantity);
  const batchQuantity = Number.isFinite(batchQtyRaw) ? Math.floor(batchQtyRaw) : 0;
  if (batchQuantity < 1) {
    return { ok: false, message: "Batch quantity must be at least 1." };
  }
  if (batchQuantity > OPERATOR_ITEM_BATCH_MAX_QUANTITY) {
    return {
      ok: false,
      message: `Maximum ${OPERATOR_ITEM_BATCH_MAX_QUANTITY} units per batch save.`,
    };
  }

  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const looseItem = Boolean(input.looseItem);
  const pkgIdRaw = String(input.packageId ?? "").trim();
  const pkgId = isUuidString(pkgIdRaw) ? pkgIdRaw : null;
  if (!looseItem && !pkgId) {
    return { ok: false, message: "Invalid package id." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const barcode = String(input.scannedBarcode ?? "").trim();
  if (!barcode) {
    return { ok: false, message: "Barcode is required." };
  }

  let pkgStore = "";
  if (!looseItem && pkgId) {
    const { data: pkgRow, error: pkgSelErr } = await supabaseServer
      .from("packages")
      .select("id, store_id, organization_id")
      .eq("id", pkgId)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (pkgSelErr) return { ok: false, message: pkgSelErr.message };
    if (!pkgRow) {
      return { ok: false, message: "Package not found for this organization." };
    }
    const pkgOrg = String((pkgRow as { organization_id?: string | null }).organization_id ?? "").trim();
    if (pkgOrg && isUuidString(pkgOrg) && pkgOrg !== organizationId) {
      return { ok: false, message: "Package organization mismatch." };
    }
    pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  }

  const scope = String(input.storeId ?? "").trim();
  const storeIdResolved =
    scope && isUuidString(scope) ? scope : pkgStore && isUuidString(pkgStore) ? pkgStore : null;
  if (
    !looseItem &&
    scope &&
    isUuidString(scope) &&
    pkgStore &&
    isUuidString(pkgStore) &&
    pkgStore !== scope
  ) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  const slipHintBase = String(input.slipContentId ?? "").trim();
  let slipDescription: string | null = null;
  let slipLinkageInherit: SlipLinkageInheritRow | null = null;
  let slipFnsku: string | null = null;
  let slipUpc: string | null = null;
  let slipExpectedQuantity: number | null = null;
  let slipOrderId: string | null = null;
  if (slipHintBase && isUuidString(slipHintBase)) {
    if (looseItem) {
      return { ok: false, message: "Slip line cannot be used for a loose item scan." };
    }
    const slipSelectAttempts = [
      `id, package_id, description, fnsku, upc, ${RETURN_SCANNER_LINKAGE_SELECT}`,
      "id, package_id, description, fnsku, upc",
      "id, package_id, description",
    ];
    let slipRow: Record<string, unknown> | null = null;
    let slipErr: { message: string } | null = null;
    for (const sel of slipSelectAttempts) {
      const r = await supabaseServer
        .from("slip_contents")
        .select(sel)
        .eq("id", slipHintBase)
        .eq("organization_id", organizationId)
        .maybeSingle();
      slipErr = r.error;
      if (!r.error && r.data && typeof r.data === "object") {
        slipRow = r.data as Record<string, unknown>;
        break;
      }
      if (r.error && !r.error.message.toLowerCase().includes("column")) break;
    }
    if (slipErr && !slipRow) return { ok: false, message: slipErr.message };
    const spkg = String(slipRow?.package_id ?? "").trim();
    if (!slipRow || !pkgId || spkg !== pkgId) {
      return { ok: false, message: "Slip line does not belong to this package." };
    }
    slipDescription =
      typeof slipRow.description === "string" ? slipRow.description.trim() : null;
    slipFnsku = typeof slipRow.fnsku === "string" ? slipRow.fnsku.trim() || null : null;
    slipUpc = typeof slipRow.upc === "string" ? slipRow.upc.trim() || null : null;
    slipExpectedQuantity = Math.max(0, Math.floor(Number(slipRow.quantity ?? 0)));
    slipOrderId = typeof slipRow.order_id === "string" ? slipRow.order_id.trim() || null : null;
    const slipResolved =
      typeof slipRow.resolved_product_id === "string" && isUuidString(slipRow.resolved_product_id.trim())
        ? slipRow.resolved_product_id.trim()
        : null;
    const slipCatalog =
      typeof slipRow.resolved_catalog_product_id === "string" &&
      isUuidString(slipRow.resolved_catalog_product_id.trim())
        ? slipRow.resolved_catalog_product_id.trim()
        : null;
    slipLinkageInherit = {
      resolved_product_id: slipResolved,
      resolved_catalog_product_id: slipCatalog,
      identifier_resolution_status:
        typeof slipRow.identifier_resolution_status === "string"
          ? slipRow.identifier_resolution_status
          : null,
      identifier_resolution_confidence: (() => {
        const n = Number(slipRow?.identifier_resolution_confidence);
        return Number.isFinite(n) ? n : null;
      })(),
    };
  } else if (slipHintBase) {
    return { ok: false, message: "Invalid slip line id." };
  }

  const tags = filterPackageItemDiscrepancyTags(input.discrepancyTags);
  if (tags.length === 0) {
    return { ok: false, message: "Select at least one condition for this unit." };
  }
  const missingItemReject = rejectPackageLevelMissingItemTag(tags);
  if (!missingItemReject.ok) return missingItemReject;

  const evidence = normalizeEvidenceUrls(input.evidenceUrls);
  if (packageItemRequiresEvidencePhotos(tags) && evidence.length === 0) {
    return { ok: false, message: "Add at least one evidence photo for the selected issue(s)." };
  }

  const exp = normalizeOptionalDate(input.expiryDate ?? null);
  const lotRaw = String(input.lotNumber ?? "").trim();
  const lot = lotRaw ? lotRaw.slice(0, 500) : null;

  const traceabilityRequired = Boolean(input.traceabilityRequired);
  if (traceabilityRequired && !exp) {
    return { ok: false, message: "Expiration date is required for this item." };
  }

  if (!storeIdResolved || !isUuidString(storeIdResolved)) {
    return { ok: false, message: "Store is required to save item scans." };
  }

  const itemName = (slipDescription || "Scanned unit").slice(0, 500);
  const optionalItemPhotoUrls = normalizeOptionalItemPhotoUrls(
    input.optionalItemPhotoUrls,
    input.optionalItemPhotoUrl,
  );
  const returnLabelUrl = String(input.returnLabelPhotoUrl ?? "").trim();
  const expiryEvidence = normalizeEvidenceUrls(input.expiryEvidenceUrls);
  const hasExpiredTag = tags.includes("expired");
  if (hasExpiredTag && expiryEvidence.length === 0) {
    return { ok: false, message: "Expiry photo is required when Expired is selected." };
  }
  let photo_evidence = buildOperatorItemUnitPhotoEvidence({
    evidenceUrls: evidence,
    expiryEvidenceUrls: expiryEvidence,
    optionalItemPhotoUrls,
  });
  if (returnLabelUrl && /^https?:\/\//i.test(returnLabelUrl)) {
    photo_evidence = { ...(photo_evidence ?? {}), return_label_url: returnLabelUrl };
  }

  const operatorNotesRaw = String(input.operatorNotes ?? "").trim().slice(0, 2000) || null;

  const scanIds = buildOperatorBarcodeResolverFields(barcode);
  const persistFnsku = (scanIds.fnsku ?? slipFnsku ?? "").trim().slice(0, 500) || undefined;
  const persistSku = (scanIds.sku ?? slipUpc ?? "").trim().slice(0, 500) || undefined;
  const persistUpc = (scanIds.upc ?? slipUpc ?? "").trim().slice(0, 500) || undefined;

  let packageSlipCode: string | null = null;
  let packageTrackingNumber: string | null = null;
  if (!looseItem && pkgId) {
    const pkgCtx = await fetchPackageReceiveContext(supabaseServer, pkgId);
    packageSlipCode = pkgCtx.slipCode;
    packageTrackingNumber = pkgCtx.trackingNumber;
  }

  let expectedPackageHintIdBase = String(input.expectedPackageHintId ?? "").trim();
  if (
    !looseItem &&
    pkgId &&
    (!expectedPackageHintIdBase || !isUuidString(expectedPackageHintIdBase))
  ) {
    try {
      const resolved = await resolveAllocatableExpectedPackageHint(supabaseServer, {
        organizationId,
        storeId: storeIdResolved,
        fnsku: persistFnsku ?? slipFnsku,
        sku: persistSku ?? slipUpc,
        upc: persistUpc,
        orderId: slipOrderId,
        packageSlipCode,
        packageTrackingNumber,
        preferredHintId: input.expectedPackageHintId,
      });
      if (resolved) expectedPackageHintIdBase = resolved;
    } catch (e) {
      return {
        ok: false,
        message: humanizeExpectedAllocationError(
          e instanceof Error ? e.message : "Expected row lookup failed.",
          {
            fnsku: persistFnsku ?? slipFnsku,
            sku: persistSku ?? slipUpc,
            slipCode: packageSlipCode,
            trackingNumber: packageTrackingNumber,
          },
        ),
      };
    }
  }

  const insertReturnBase = {
    organization_id: organizationId,
    store_id: storeIdResolved,
    marketplace: "amazon" as const,
    item_name: itemName,
    conditions: [...tags],
    expiration_date: exp ?? undefined,
    batch_number: lot ?? undefined,
    photo_evidence,
    actor_profile_id: sessionUserId,
  };

  const batchAllocation = input.batchAllocation;
  const insertedIds: string[] = [];
  let offSlipCount = 0;

  for (let unitIndex = 0; unitIndex < batchQuantity; unitIndex++) {
    const saveAsOffSlip = itemBatchUnitSaveAsOffSlip(batchAllocation, unitIndex);
    if (saveAsOffSlip) offSlipCount++;

    const operatorNotes = saveAsOffSlip
      ? appendOffSlipAuditNote(operatorNotesRaw)
      : operatorNotesRaw;

    const ins = await insertReturn({
      ...insertReturnBase,
      notes: operatorNotes ?? undefined,
      package_id: looseItem ? undefined : pkgId ?? undefined,
      fnsku: persistFnsku,
      sku: persistSku,
      asin: scanIds.asin?.slice(0, 500),
      product_identifier: persistUpc,
      order_id: slipOrderId ?? undefined,
    });

    if (!ins.ok || !ins.data?.id) {
      await rollbackOperatorPackageReturnItemsOnAllocationFailure(insertedIds);
      return { ok: false, message: ins.error ?? "Failed to save item scan." };
    }

    const returnItemId = ins.data.id;
    insertedIds.push(returnItemId);

    const finalizeLinkageParams = {
      organizationId,
      storeId: storeIdResolved,
      packageId: looseItem ? null : pkgId,
      looseItem,
      slipLinkage: slipLinkageInherit,
      slipContentId:
        saveAsOffSlip || !slipHintBase || !isUuidString(slipHintBase) ? null : slipHintBase,
      slipExpectedQuantity: saveAsOffSlip ? 0 : slipExpectedQuantity,
      expectedPackageHintId:
        saveAsOffSlip || !isUuidString(expectedPackageHintIdBase) ? null : expectedPackageHintIdBase,
      packageSlipCode,
      packageTrackingNumber,
      orderId: slipOrderId,
      disposition: null as string | null,
      scanIds: {
        asin: scanIds.asin ?? null,
        fnsku: persistFnsku ?? null,
        sku: persistSku ?? null,
        upc: persistUpc ?? null,
      },
    };

    const finalize = await finalizeOperatorPackageItemLinkage(returnItemId, finalizeLinkageParams);
    if (!finalize.ok) {
      await rollbackOperatorPackageReturnItemsOnAllocationFailure(insertedIds);
      return { ok: false, message: finalize.error };
    }
    await tryPromoteScannerClaimForReturnItem(returnItemId, organizationId, sessionUserId);
  }

  const primaryId = insertedIds[0]!;
  const { linkage } = await hydrateReturnItemProductLinkage(supabaseServer, primaryId, organizationId);
  const product_linkage =
    linkage ??
    buildProductLinkageDisplayContract(
      {
        fnsku: scanIds.fnsku ?? null,
        sku: scanIds.sku ?? null,
        product_identifier: scanIds.upc ?? null,
        item_name: itemName,
      },
      new Map(),
    );

  return { ok: true, ids: insertedIds, product_linkage, offSlipCount };
}

export type OperatorMobileCorrectionPermissions = {
  moveBox: boolean;
  voidBox: boolean;
  editItem: boolean;
  deleteItem: boolean;
  closePallet: boolean;
  reopenPallet: boolean;
  closeShipmentReview: boolean;
  reopenShipmentReview: boolean;
};

/**
 * Client snapshot for Edit All correction actions (move/void visibility).
 */
export async function getOperatorMobileCorrectionPermissionsAction(
  requestedOrganizationId: string,
): Promise<
  | { ok: true; permissions: OperatorMobileCorrectionPermissions }
  | { ok: false; message: string }
> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const org = await assertUserCanAccessOrganization(organizationId);
  if (!org.ok) {
    return { ok: false, message: org.error };
  }
  const [moveBox, voidBox, editItem, deleteItem, closePallet, reopenPallet, closeShipmentReview, reopenShipmentReview] =
    await Promise.all([
    userHasOperatorMobilePermission(sessionUserId, organizationId, OPERATOR_MOBILE_MOVE_BOX),
    userHasOperatorMobilePermission(sessionUserId, organizationId, OPERATOR_MOBILE_VOID_BOX),
    userHasOperatorMobilePermission(sessionUserId, organizationId, OPERATOR_MOBILE_EDIT_ITEM),
    userHasOperatorMobilePermission(sessionUserId, organizationId, OPERATOR_MOBILE_DELETE_ITEM),
    userHasOperatorMobilePermission(sessionUserId, organizationId, OPERATOR_MOBILE_CLOSE_PALLET),
    userHasOperatorMobilePermission(sessionUserId, organizationId, OPERATOR_MOBILE_REOPEN_PALLET),
    userHasOperatorMobilePermission(sessionUserId, organizationId, OPERATOR_MOBILE_CLOSE_SHIPMENT_REVIEW),
    userHasOperatorMobilePermission(sessionUserId, organizationId, OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW),
  ]);
  return {
    ok: true,
    permissions: {
      moveBox,
      voidBox,
      editItem,
      deleteItem,
      closePallet,
      reopenPallet,
      closeShipmentReview,
      reopenShipmentReview,
    },
  };
}

export type MoveOperatorIntakeBoxToPalletInput = {
  packageId: string;
  targetPalletTrackingOrNumber: string;
  requestedOrganizationId: string;
  storeId?: string | null;
};

export type MoveOperatorIntakeBoxToPalletResult =
  | {
      ok: true;
      packageId: string;
      palletId: string;
      palletNumber: string;
      trackingNumber: string | null;
    }
  | { ok: false; message: string };

/**
 * Moves a saved package to another pallet (same org/store). Preserves return_items and slip_contents.
 */
export async function moveOperatorIntakeBoxToPalletAction(
  input: MoveOperatorIntakeBoxToPalletInput,
): Promise<MoveOperatorIntakeBoxToPalletResult> {
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const gate = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_MOVE_BOX);
  if (!gate.ok) return { ok: false, message: gate.message };

  const packageId = String(input.packageId ?? "").trim();
  if (!isUuidString(packageId)) {
    return { ok: false, message: "Invalid package id." };
  }
  const targetRaw = String(input.targetPalletTrackingOrNumber ?? "").trim();
  if (!targetRaw) {
    return { ok: false, message: "Enter a target pallet tracking number or pallet number." };
  }

  const storeScope = String(input.storeId ?? "").trim();

  const { data: pkgRow, error: pkgErr } = await supabaseServer
    .from("packages")
    .select("id, organization_id, store_id, pallet_id, package_code")
    .eq("id", packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgErr) return { ok: false, message: pkgErr.message };
  if (!pkgRow) {
    return { ok: false, message: "Package not found for this organization." };
  }
  const pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  if (
    storeScope &&
    isUuidString(storeScope) &&
    pkgStore &&
    isUuidString(pkgStore) &&
    pkgStore !== storeScope
  ) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  let targetPallet: OperatorPalletTrackingRow | null = null;
  try {
    targetPallet = await findPalletByTrackingOrNumber(
      supabaseServer,
      organizationId,
      targetRaw,
      storeScope || pkgStore || null,
    );
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Pallet lookup failed." };
  }
  if (!targetPallet) {
    return { ok: false, message: "Target pallet not found for this organization and store." };
  }

  const currentPalletId = String((pkgRow as { pallet_id?: string | null }).pallet_id ?? "").trim();
  if (currentPalletId === targetPallet.id) {
    return {
      ok: true,
      packageId,
      palletId: targetPallet.id,
      palletNumber: targetPallet.pallet_number,
      trackingNumber: targetPallet.tracking_number,
    };
  }

  const actor = await resolveAuditActorForSession();
  const patch: Record<string, unknown> = {
    pallet_id: targetPallet.id,
    updated_at: new Date().toISOString(),
  };
  if (actor.userId) patch.updated_by = actor.userId;

  const { error: upErr } = await supabaseServer.from("packages").update(patch).eq("id", packageId);
  if (upErr) return { ok: false, message: upErr.message };

  const pkgStoreForScope = storeScope || pkgStore || "";
  if (isUuidString(pkgStoreForScope)) {
    const pkgCtx = await fetchPackageReceiveContext(supabaseServer, packageId);
    const receiveScopeKey = buildReceiveScopeKey({
      organizationId,
      storeId: pkgStoreForScope,
      packageId,
      slipCode: pkgCtx.slipCode,
    });
    const moveAlloc = await moveExpectedItemsForPackageScope(supabaseServer, {
      packageId,
      organizationId,
      storeId: pkgStoreForScope,
      receiveScopeKey,
      trackingNumber: pkgCtx.trackingNumber,
      palletId: targetPallet.id,
      actorId: actor.userId && isUuidString(actor.userId) ? actor.userId : null,
    });
    if (!moveAlloc.ok) {
      return { ok: false, message: moveAlloc.error };
    }
  }

  const syncPallet = await syncReturnItemsPalletForPackage(supabaseServer, {
    packageId,
    organizationId,
    palletId: targetPallet.id,
  });
  if (!syncPallet.ok) {
    return { ok: false, message: syncPallet.error };
  }

  return {
    ok: true,
    packageId,
    palletId: targetPallet.id,
    palletNumber: targetPallet.pallet_number,
    trackingNumber: targetPallet.tracking_number,
  };
}

export type VoidOperatorIntakeBoxPackageInput = {
  packageId: string;
  requestedOrganizationId: string;
  storeId?: string | null;
};

export type VoidOperatorIntakeBoxPackageResult =
  | { ok: true; packageId: string; palletId: string | null; wasDirectBox: boolean }
  | { ok: false; message: string };

/**
 * Soft-voids a package (`deleted_at`). Releases expected allocation for each active return_items row first.
 * Slip-only packages (slip_contents, no return_items) may be voided without allocation release.
 */
export async function voidOperatorIntakeBoxPackageAction(
  input: VoidOperatorIntakeBoxPackageInput,
): Promise<VoidOperatorIntakeBoxPackageResult> {
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const gate = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_VOID_BOX);
  if (!gate.ok) return { ok: false, message: gate.message };

  const packageId = String(input.packageId ?? "").trim();
  if (!isUuidString(packageId)) {
    return { ok: false, message: "Invalid package id." };
  }

  const storeScope = String(input.storeId ?? "").trim();

  const { data: pkgRow, error: pkgErr } = await supabaseServer
    .from("packages")
    .select("id, organization_id, store_id, pallet_id, package_code, tracking_number")
    .eq("id", packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgErr) return { ok: false, message: pkgErr.message };
  if (!pkgRow) {
    return { ok: false, message: "Package not found for this organization." };
  }
  const pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  if (
    storeScope &&
    isUuidString(storeScope) &&
    pkgStore &&
    isUuidString(pkgStore) &&
    pkgStore !== storeScope
  ) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  // Guard: package must be empty (no active scanned items) before voiding
  const { count: riCount, error: riCountErr } = await supabaseServer
    .from("return_items")
    .select("id", { count: "exact", head: true })
    .eq("package_id", packageId)
    .is("deleted_at", null);
  if (riCountErr) return { ok: false, message: riCountErr.message };
  if (riCount && riCount > 0) {
    return {
      ok: false,
      message: `This box has ${riCount} scanned item${riCount !== 1 ? "s" : ""}. Remove all items first before voiding the box.`,
    };
  }

  const releaseAlloc = await releaseExpectedItemsForPackage(supabaseServer, {
    packageId,
    organizationId,
    softDelete: true,
  });
  if (!releaseAlloc.ok) {
    return { ok: false, message: releaseAlloc.error };
  }

  const actor = await resolveAuditActorForSession();
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    deleted_at: now,
    updated_at: now,
  };
  if (actor.userId) patch.updated_by = actor.userId;

  const { error: upErr } = await supabaseServer.from("packages").update(patch).eq("id", packageId);
  if (upErr) return { ok: false, message: upErr.message };

  // Repair inconsistent rows: soft-delete any return_items still linked (release RPC should have handled active rows).
  const { error: riVoidErr } = await supabaseServer
    .from(RETURN_ITEMS_TABLE)
    .update(patch)
    .eq("package_id", packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null);
  if (riVoidErr) return { ok: false, message: riVoidErr.message };

  const palletIdRaw = String((pkgRow as { pallet_id?: string | null }).pallet_id ?? "").trim();
  const palletId = isUuidString(palletIdRaw) ? palletIdRaw : null;
  const wasDirectBox = !palletId;

  if (wasDirectBox) {
    const baselineCodes = [
      String((pkgRow as { package_code?: string | null }).package_code ?? "").trim(),
      String((pkgRow as { tracking_number?: string | null }).tracking_number ?? "").trim(),
    ].filter(Boolean);
    try {
      await softDeleteShipmentEntryBaselineReturnItems(
        supabaseServer,
        organizationId,
        storeScope || pkgStore || null,
        baselineCodes,
        now,
      );
    } catch (baselineErr) {
      const msg =
        baselineErr instanceof Error
          ? baselineErr.message
          : "Package voided but baseline return items could not be cleared.";
      return { ok: false, message: msg };
    }
  }

  return { ok: true, packageId, palletId, wasDirectBox };
}

export type VoidOperatorIntakePalletInput = {
  palletId: string;
  requestedOrganizationId: string;
  storeId?: string | null;
};

export type VoidOperatorIntakePalletResult =
  | { ok: true; palletId: string; packagesVoided: number; itemsVoided: number }
  | { ok: false; message: string };

/**
 * Soft-voids a pallet (`deleted_at`) and cascades packages/return_items per existing void rules.
 */
export async function voidOperatorIntakePalletAction(
  input: VoidOperatorIntakePalletInput,
): Promise<VoidOperatorIntakePalletResult> {
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const gate = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_VOID_BOX);
  if (!gate.ok) return { ok: false, message: gate.message };

  const palletId = String(input.palletId ?? "").trim();
  if (!isUuidString(palletId)) {
    return { ok: false, message: "Invalid pallet id." };
  }

  const storeScope = String(input.storeId ?? "").trim();

  const { data: palRow, error: palErr } = await supabaseServer
    .from("pallets")
    .select("id, organization_id, store_id, pallet_number, tracking_number")
    .eq("id", palletId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (palErr) return { ok: false, message: palErr.message };
  if (!palRow) {
    return { ok: false, message: "Pallet not found for this organization." };
  }
  const palStore = String((palRow as { store_id?: string | null }).store_id ?? "").trim();
  if (
    storeScope &&
    isUuidString(storeScope) &&
    palStore &&
    isUuidString(palStore) &&
    palStore !== storeScope
  ) {
    return { ok: false, message: "This pallet belongs to another store — select the correct store." };
  }

  // Cascade void via softVoidPalletWithExpectedRelease (packages + return_items + allocation release).
  const actor = await resolveAuditActorForSession();
  const voided = await softVoidPalletWithExpectedRelease(supabaseServer, {
    palletId,
    organizationId,
    updatedBy: actor.userId && isUuidString(actor.userId) ? actor.userId : null,
  });
  if (!voided.ok) return { ok: false, message: voided.error };

  return {
    ok: true,
    palletId,
    packagesVoided: voided.packagesVoided,
    itemsVoided: voided.itemsVoided,
  };
}

export type UpdateOperatorPackageItemInput = {
  requestedOrganizationId: string;
  returnItemId: string;
  storeId?: string | null;
  discrepancyTags: ItemUnitDiscrepancyTagKey[];
  expiryDate?: string | null;
  lotNumber?: string | null;
  evidenceUrls?: string[] | null;
  expiryEvidenceUrls?: string[] | null;
  optionalItemPhotoUrls?: string[] | null;
  optionalItemPhotoUrl?: string | null;
  traceabilityRequired?: boolean;
  operatorNotes?: string | null;
};

export type UpdateOperatorPackageItemResult =
  | { ok: true; id: string; product_linkage: ProductLinkageDisplayContract }
  | { ok: false; message: string };

/**
 * Updates editable fields on an existing scanned `return_items` row — no insert, no re-allocation.
 */
export async function updateOperatorPackageItemAction(
  input: UpdateOperatorPackageItemInput,
): Promise<UpdateOperatorPackageItemResult> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const returnItemId = String(input.returnItemId ?? "").trim();
  if (!isUuidString(returnItemId)) {
    return { ok: false, message: "Invalid return item id." };
  }

  const { data: row, error: loadErr } = await supabaseServer
    .from(RETURN_ITEMS_TABLE)
    .select("id, organization_id, store_id, package_id")
    .eq("id", returnItemId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (loadErr) return { ok: false, message: loadErr.message };
  if (!row) return { ok: false, message: "Scanned item not found." };

  const scope = String(input.storeId ?? "").trim();
  const rowStore = String((row as { store_id?: string | null }).store_id ?? "").trim();
  if (scope && isUuidString(scope) && rowStore && isUuidString(rowStore) && rowStore !== scope) {
    return { ok: false, message: "This item belongs to another store — select the correct store." };
  }

  const rowPackageId = String((row as { package_id?: string | null }).package_id ?? "").trim();
  if (rowPackageId && isUuidString(rowPackageId)) {
    const receiveGate = await assertPackageReceiveOpenForPackageEdits(organizationId, rowPackageId);
    if (!receiveGate.ok) return { ok: false, message: receiveGate.message };
  }

  const tags = normalizeItemUnitDiscrepancySelection(
    filterPackageItemDiscrepancyTags(input.discrepancyTags),
  );
  if (isPackageLevelShortageTagBlocked(input.discrepancyTags ?? [])) {
    return {
      ok: false,
      message:
        "Missing/shortage is recorded at box finalize — scan received units or mark empty box when closing the package.",
    };
  }
  if (tags.length === 0) {
    return { ok: false, message: "Select at least one condition for this unit." };
  }
  const missingItemRejectUpdate = rejectPackageLevelMissingItemTag(tags);
  if (!missingItemRejectUpdate.ok) return missingItemRejectUpdate;

  const evidence = normalizeEvidenceUrls(input.evidenceUrls);
  if (packageItemRequiresEvidencePhotos(tags) && evidence.length === 0) {
    return { ok: false, message: "Add at least one evidence photo for the selected issue(s)." };
  }

  const exp = normalizeOptionalDate(input.expiryDate ?? null);
  const lotRaw = String(input.lotNumber ?? "").trim();
  const lot = lotRaw ? lotRaw.slice(0, 500) : null;
  const traceabilityRequired = Boolean(input.traceabilityRequired);
  if (traceabilityRequired && !exp) {
    return { ok: false, message: "Expiration date is required for this item." };
  }

  const optionalItemPhotoUrls = normalizeOptionalItemPhotoUrls(
    input.optionalItemPhotoUrls,
    input.optionalItemPhotoUrl,
  );
  const expiryEvidence = normalizeEvidenceUrls(input.expiryEvidenceUrls);
  const hasExpiredTag = tags.includes("expired");
  if (hasExpiredTag && expiryEvidence.length === 0) {
    return { ok: false, message: "Expiry photo is required when Expired is selected." };
  }
  const photo_evidence = buildOperatorItemUnitPhotoEvidence({
    evidenceUrls: evidence,
    expiryEvidenceUrls: expiryEvidence,
    optionalItemPhotoUrls,
  });

  const operatorNotes = String(input.operatorNotes ?? "").trim().slice(0, 2000) || null;

  const actor = await resolveAuditActorForSession();
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    conditions: [...tags],
    expiration_date: exp,
    batch_number: lot,
    photo_evidence,
    notes: operatorNotes,
    updated_at: now,
  };
  if (actor.userId && isUuidString(actor.userId)) patch.updated_by = actor.userId;

  const { error: upErr } = await supabaseServer
    .from(RETURN_ITEMS_TABLE)
    .update(patch)
    .eq("id", returnItemId)
    .eq("organization_id", organizationId);
  if (upErr) return { ok: false, message: upErr.message };

  const { linkage } = await hydrateReturnItemProductLinkage(supabaseServer, returnItemId, organizationId);
  const product_linkage =
    linkage ??
    buildProductLinkageDisplayContract(
      { item_name: "Scanned unit" },
      new Map(),
    );

  return { ok: true, id: returnItemId, product_linkage };
}

/** Service-role Shipment Entry gate lookup — excludes voided package scans reliably. */
export async function lookupShipmentEntryScanCodeAction(
  requestedOrganizationId: string,
  storeId: string,
  code: string,
  opts?: { skipExpensiveFallback?: boolean; gateFastNegative?: boolean },
): Promise<{ ok: true; lookup: ShipmentEntryLookupResult } | { ok: false; error: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }
  const sid = String(storeId ?? "").trim();
  if (!isUuidString(sid)) {
    return { ok: false, error: "Store is required." };
  }
  try {
    const lookup = await lookupShipmentEntryScanCode(supabaseServer, organizationId, sid, code, opts);
    return { ok: true, lookup };
  } catch (e) {
    const msg = formatSupabaseActionError(e, "Lookup failed.");
    console.error("[lookupShipmentEntryScanCodeAction]", msg, e);
    return { ok: false, error: msg };
  }
}

export type FetchInventoryItemStatusLinesForGateInput =
  | { mode: "tracking"; trackingNumber: string }
  | { mode: "exact"; field: InventoryViewMatchField; value: string };

/** Batch catalog names for identify-gate rows (one products query, no OCR auto-link). */
export async function fetchGateProductNamesByIdsAction(
  requestedOrganizationId: string,
  productIds: string[],
): Promise<{ ok: true; names: Record<string, string> } | { ok: false; error: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }
  const ids = [...new Set(productIds.map((id) => String(id ?? "").trim()).filter(isUuidString))];
  if (!ids.length) return { ok: true, names: {} };
  try {
    const nameMap = await fetchProductNamesByResolvedIds(
      supabaseServer as unknown as ProductsLookupClient,
      ids,
    );
    return { ok: true, names: Object.fromEntries(nameMap) };
  } catch (e) {
    const msg = formatSupabaseActionError(e, "Product name fetch failed.");
    console.error("[fetchGateProductNamesByIdsAction]", msg, e);
    return { ok: false, error: msg };
  }
}

/** Service-role inventory line fetch for identify gate — voided package scans excluded. */
export async function fetchInventoryItemStatusLinesForGateAction(
  requestedOrganizationId: string,
  storeId: string,
  input: FetchInventoryItemStatusLinesForGateInput,
): Promise<{ ok: true; rows: VInventoryStatusRow[] } | { ok: false; error: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }
  const sid = String(storeId ?? "").trim();
  if (!isUuidString(sid)) {
    return { ok: false, error: "Store is required." };
  }
  try {
    if (input.mode === "tracking") {
      const { rows } = await fetchVInventoryItemStatusLinesForTrackingNormalized(
        supabaseServer,
        organizationId,
        sid,
        input.trackingNumber,
      );
      return { ok: true, rows };
    }
    const { rows } = await fetchVInventoryItemStatusLinesExact(
      supabaseServer,
      organizationId,
      sid,
      input.field,
      input.value,
    );
    return { ok: true, rows };
  } catch (e) {
    const msg = formatSupabaseActionError(e, "Inventory line fetch failed.");
    console.error("[fetchInventoryItemStatusLinesForGateAction]", msg, e);
    return { ok: false, error: msg };
  }
}

// ─── Slip Reconciliation ──────────────────────────────────────────────────────

/**
 * After a packing slip is replaced in Box Info (while items are already scanned),
 * re-count how many scanned units match new slip lines. Slip linkage is inferred at
 * read time from barcodes — `return_items` has no `slip_content_id` column.
 *
 * Called AFTER updateOperatorIntakeBoxPackageAction so that new slip_contents rows exist.
 */
export async function reconcileReturnItemsSlipContentsAction(input: {
  requestedOrganizationId: string;
  packageId: string;
  newSlipCode: string | null;
}): Promise<{ ok: boolean; matched: number; unlinked: number; error?: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, matched: 0, unlinked: 0, error: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, matched: 0, unlinked: 0, error: "Could not resolve organization." };
  }
  const pkgId = String(input.packageId ?? "").trim();
  if (!isUuidString(pkgId)) {
    return { ok: false, matched: 0, unlinked: 0, error: "Invalid package id." };
  }

  try {
    const { data: newSlipRows, error: slipErr } = await supabaseServer
      .from("slip_contents")
      .select("id, fnsku, upc, quantity")
      .eq("package_id", pkgId)
      .is("deleted_at", null);
    if (slipErr) return { ok: false, matched: 0, unlinked: 0, error: slipErr.message };

    const slipMatchRows = slipLinesToBarcodeMatchRows(newSlipRows ?? []);
    const riLoad = await loadPackageReturnItemsForQtyBySlip(pkgId, organizationId, false);
    if (!riLoad.ok) return { ok: false, matched: 0, unlinked: 0, error: riLoad.message };

    let matched = 0;
    let unlinked = 0;
    for (const raw of riLoad.rows) {
      const row = raw as Record<string, unknown>;
      const fnsku = typeof row.fnsku === "string" ? row.fnsku : null;
      const sku = typeof row.sku === "string" ? row.sku : null;
      const product_identifier = typeof row.product_identifier === "string" ? row.product_identifier : null;
      const operator_notes = typeof row.notes === "string" ? row.notes : null;
      const scanned_barcode = scannedBarcodeFromReturnItemRow({ fnsku, sku, product_identifier });
      const slipId = returnItemNotesMarkOffSlip(operator_notes)
        ? null
        : slipContentIdForReturnItemBarcode(scanned_barcode, slipMatchRows);
      if (slipId) matched++;
      else unlinked++;
    }

    return { ok: true, matched, unlinked };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    return { ok: false, matched: 0, unlinked: 0, error: msg };
  }
}

// ─── Slip line missing expected (package review — no return_items rows) ───────

export type MarkOperatorSlipMissingExpectedInput = {
  requestedOrganizationId: string;
  packageId: string;
  storeId?: string | null;
  /** When set, mark only this slip line; otherwise all lines with remaining missing. */
  slipContentId?: string | null;
  /** Units to add as missing on the target line(s). Omit to mark all remaining on target. */
  missingQty?: number;
  note?: string | null;
};

/**
 * Operator missing review is metadata only; physical items live in `return_items`.
 * Persists marks on `packages.manifest_data.operator_item_scan.missing_review`.
 */
export async function markOperatorSlipMissingExpectedAction(
  input: MarkOperatorSlipMissingExpectedInput,
): Promise<{ ok: true; updated: number } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const pkgId = String(input.packageId ?? "").trim();
  if (!isUuidString(pkgId)) {
    return { ok: false, message: "Invalid package id." };
  }

  const { data: pkgRow, error: pkgErr } = await supabaseServer
    .from("packages")
    .select("id, store_id, manifest_data")
    .eq("id", pkgId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgErr) return { ok: false, message: pkgErr.message };
  if (!pkgRow) return { ok: false, message: "Package not found for this organization." };

  const scope = String(input.storeId ?? "").trim();
  const pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  if (scope && isUuidString(scope) && pkgStore && isUuidString(pkgStore) && pkgStore !== scope) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  const targetSlipId = String(input.slipContentId ?? "").trim();
  if (targetSlipId && !isUuidString(targetSlipId)) {
    return { ok: false, message: "Invalid slip line id." };
  }

  const slipSelectAttempts = [
    "id, quantity, fnsku, upc, parsed_asin, sku, resolved_product_id, expected_item_id",
    "id, quantity, fnsku, upc, resolved_product_id",
    "id, quantity, fnsku, upc",
    "id, quantity",
  ];
  let slipRes: { data: unknown; error: { message: string } | null } | null = null;
  for (const sel of slipSelectAttempts) {
    let q = supabaseServer.from("slip_contents").select(sel).eq("package_id", pkgId);
    if (targetSlipId) q = q.eq("id", targetSlipId);
    const r = await q.order("sort_index", { ascending: true });
    slipRes = r;
    if (!r.error) break;
  }
  if (!slipRes || slipRes.error) {
    return { ok: false, message: slipRes?.error?.message ?? "slip_contents load failed." };
  }
  const lines = Array.isArray(slipRes.data) ? slipRes.data : [];
  if (lines.length === 0) {
    return { ok: false, message: targetSlipId ? "Slip line not found." : "No slip lines on this package." };
  }

  const riLoad = await loadPackageReturnItemsForQtyBySlip(pkgId, organizationId, false);
  if (!riLoad.ok) return { ok: false, message: riLoad.message };
  const slipMatchRows = slipLinesToBarcodeMatchRows(lines);
  const { receivedBySlip } = computePackageScannedQtyBySlipFromReturnItems(
    riLoad.rows,
    slipMatchRows,
  );

  const explicitQty =
    input.missingQty != null && Number.isFinite(Number(input.missingQty))
      ? Math.max(0, Math.floor(Number(input.missingQty)))
      : null;

  const manifestData = (pkgRow as { manifest_data?: unknown }).manifest_data;
  const markedAt = new Date().toISOString();
  const newEntries: OperatorMissingReviewEntry[] = [];

  for (const raw of lines) {
    const row = raw as Record<string, unknown>;
    const slipId = String(row.id ?? "").trim();
    if (!slipId || !isUuidString(slipId)) continue;
    const expected = Math.max(0, Math.floor(Number(row.quantity ?? 0)));
    const received = receivedBySlip.get(slipId) ?? 0;
    const manifestRecorded = missingReviewRecordedQtyForSlip(manifestData, slipId);
    const lineState = computeSlipLineExpectedVsReceived({
      expectedQty: expected,
      receivedQty: received,
      manifestRecordedMissingQty: manifestRecorded,
    });
    if (lineState.remainingMissing <= 0) continue;

    const addQty =
      explicitQty != null && targetSlipId
        ? explicitQty
        : lineState.remainingMissing;

    if (addQty <= 0) {
      if (targetSlipId) return { ok: false, message: "No missing units to record." };
      continue;
    }
    if (addQty > lineState.remainingMissing) {
      if (targetSlipId) {
        return {
          ok: false,
          message: `Cannot mark ${addQty} missing — only ${lineState.remainingMissing} unit(s) remain unaccounted.`,
        };
      }
      continue;
    }

    const priorMarked = lineState.recordedMissing;
    const resolvedProductId = String(row.resolved_product_id ?? "").trim() || null;
    const expectedPackageId = String(row.expected_item_id ?? "").trim() || null;
    const asin =
      String(row.parsed_asin ?? "").trim() ||
      null;
    const fnsku = String(row.fnsku ?? "").trim() || null;
    const sku = String(row.sku ?? "").trim() || null;

    newEntries.push(
      buildOperatorMissingReviewEntry({
        slipContentId: slipId,
        expectedPackageId,
        resolvedProductId,
        asin,
        fnsku,
        sku,
        expectedQty: expected,
        scannedQty: received,
        additionalMissingQty: addQty,
        priorMarkedQty: priorMarked,
        markedBy: sessionUserId,
        markedAt,
        note: input.note ?? null,
      }),
    );
  }

  if (newEntries.length === 0) {
    return {
      ok: false,
      message: targetSlipId
        ? "No remaining missing units to record on this slip line."
        : "No slip lines with remaining missing units.",
    };
  }

  const manifest_data = mergePackageManifestMissingReview(manifestData, newEntries);
  const { error: updErr } = await supabaseServer
    .from("packages")
    .update({ manifest_data, updated_at: markedAt })
    .eq("id", pkgId)
    .eq("organization_id", organizationId);
  if (updErr) return { ok: false, message: updErr.message };

  return { ok: true, updated: newEntries.length };
}

export type UndoOperatorSlipMissingReviewInput = {
  requestedOrganizationId: string;
  packageId: string;
  storeId?: string | null;
  slipContentId: string;
};

/** Remove one slip line's operator missing-review metadata entry (no return_items changes). */
export async function undoOperatorSlipMissingReviewAction(
  input: UndoOperatorSlipMissingReviewInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const pkgId = String(input.packageId ?? "").trim();
  if (!isUuidString(pkgId)) {
    return { ok: false, message: "Invalid package id." };
  }
  const slipId = String(input.slipContentId ?? "").trim();
  if (!isUuidString(slipId)) {
    return { ok: false, message: "Invalid slip line id." };
  }

  const { data: pkgRow, error: pkgErr } = await supabaseServer
    .from("packages")
    .select("id, store_id, manifest_data")
    .eq("id", pkgId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgErr) return { ok: false, message: pkgErr.message };
  if (!pkgRow) return { ok: false, message: "Package not found for this organization." };

  const scope = String(input.storeId ?? "").trim();
  const pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  if (scope && isUuidString(scope) && pkgStore && isUuidString(pkgStore) && pkgStore !== scope) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  const manifestData = (pkgRow as { manifest_data?: unknown }).manifest_data;
  if (!missingReviewEntryForSlip(manifestData, slipId)) {
    return { ok: false, message: "No missing review entry on this slip line." };
  }

  const markedAt = new Date().toISOString();
  const manifest_data = removeMissingReviewEntryFromManifest(manifestData, slipId);
  const { error: updErr } = await supabaseServer
    .from("packages")
    .update({ manifest_data, updated_at: markedAt })
    .eq("id", pkgId)
    .eq("organization_id", organizationId);
  if (updErr) return { ok: false, message: updErr.message };

  return { ok: true };
}

export type EditOperatorSlipMissingReviewInput = {
  requestedOrganizationId: string;
  packageId: string;
  storeId?: string | null;
  slipContentId: string;
  operatorMarkedMissingQty: number;
  note?: string | null;
};

/**
 * Update operator missing-review metadata for one slip line.
 * `operatorMarkedMissingQty` of 0 removes the entry (same as undo).
 */
export async function editOperatorSlipMissingReviewAction(
  input: EditOperatorSlipMissingReviewInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const pkgId = String(input.packageId ?? "").trim();
  if (!isUuidString(pkgId)) {
    return { ok: false, message: "Invalid package id." };
  }
  const slipId = String(input.slipContentId ?? "").trim();
  if (!isUuidString(slipId)) {
    return { ok: false, message: "Invalid slip line id." };
  }

  const qty = Math.max(0, Math.floor(Number(input.operatorMarkedMissingQty ?? 0)));
  if (!Number.isFinite(Number(input.operatorMarkedMissingQty))) {
    return { ok: false, message: "Invalid marked missing quantity." };
  }

  const { data: pkgRow, error: pkgErr } = await supabaseServer
    .from("packages")
    .select("id, store_id, manifest_data")
    .eq("id", pkgId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgErr) return { ok: false, message: pkgErr.message };
  if (!pkgRow) return { ok: false, message: "Package not found for this organization." };

  const scope = String(input.storeId ?? "").trim();
  const pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  if (scope && isUuidString(scope) && pkgStore && isUuidString(pkgStore) && pkgStore !== scope) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  const manifestData = (pkgRow as { manifest_data?: unknown }).manifest_data;
  if (!missingReviewEntryForSlip(manifestData, slipId)) {
    return { ok: false, message: "No missing review entry on this slip line." };
  }

  const markedAt = new Date().toISOString();

  if (qty === 0) {
    const manifest_data = removeMissingReviewEntryFromManifest(manifestData, slipId);
    const { error: updErr } = await supabaseServer
      .from("packages")
      .update({ manifest_data, updated_at: markedAt })
      .eq("id", pkgId)
      .eq("organization_id", organizationId);
    if (updErr) return { ok: false, message: updErr.message };
    return { ok: true };
  }

  const slipSelectAttempts = [
    "id, quantity, fnsku, upc, parsed_asin, sku, resolved_product_id, expected_item_id",
    "id, quantity, fnsku, upc, resolved_product_id",
    "id, quantity, fnsku, upc",
    "id, quantity",
  ];
  let slipRes: { data: unknown; error: { message: string } | null } | null = null;
  for (const sel of slipSelectAttempts) {
    const r = await supabaseServer
      .from("slip_contents")
      .select(sel)
      .eq("package_id", pkgId)
      .eq("id", slipId)
      .maybeSingle();
    slipRes = r;
    if (!r.error) break;
  }
  if (!slipRes || slipRes.error) {
    return { ok: false, message: slipRes?.error?.message ?? "slip_contents load failed." };
  }
  const row = slipRes.data as Record<string, unknown> | null;
  if (!row) return { ok: false, message: "Slip line not found." };

  const expected = Math.max(0, Math.floor(Number(row.quantity ?? 0)));
  const riLoad = await loadPackageReturnItemsForQtyBySlip(pkgId, organizationId, false);
  if (!riLoad.ok) return { ok: false, message: riLoad.message };
  const slipMatchRows = slipLinesToBarcodeMatchRows([row]);
  const { receivedBySlip } = computePackageScannedQtyBySlipFromReturnItems(riLoad.rows, slipMatchRows);
  const received = receivedBySlip.get(slipId) ?? 0;
  const computedMissing = Math.max(0, expected - received);

  if (qty > computedMissing) {
    return {
      ok: false,
      message: "Marked missing quantity cannot exceed computed missing quantity.",
    };
  }

  const resolvedProductId = String(row.resolved_product_id ?? "").trim() || null;
  const expectedPackageId = String(row.expected_item_id ?? "").trim() || null;
  const asin = String(row.parsed_asin ?? "").trim() || null;
  const fnsku = String(row.fnsku ?? "").trim() || null;
  const sku = String(row.sku ?? "").trim() || null;

  const entry = buildOperatorMissingReviewEntry({
    slipContentId: slipId,
    expectedPackageId,
    resolvedProductId,
    asin,
    fnsku,
    sku,
    expectedQty: expected,
    scannedQty: received,
    additionalMissingQty: qty,
    priorMarkedQty: 0,
    markedBy: sessionUserId,
    markedAt,
    note: input.note ?? null,
  });

  const manifest_data = mergePackageManifestMissingReview(manifestData, [entry]);
  const { error: updErr } = await supabaseServer
    .from("packages")
    .update({ manifest_data, updated_at: markedAt })
    .eq("id", pkgId)
    .eq("organization_id", organizationId);
  if (updErr) return { ok: false, message: updErr.message };

  return { ok: true };
}

/**
 * Record box as empty: package-level manifest metadata only — no `return_items` rows.
 * Fails when active physical `return_items` exist for the package.
 */
export async function saveOperatorEmptyBoxAction(input: {
  requestedOrganizationId: string;
  packageId: string;
  storeId?: string | null;
  note?: string | null;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const pkgId = String(input.packageId ?? "").trim();
  if (!isUuidString(pkgId)) return { ok: false, message: "Invalid package id." };

  const { data: riRows, error: riErr } = await supabaseServer
    .from("return_items")
    .select("id")
    .eq("package_id", pkgId)
    .is("deleted_at", null)
    .limit(1);
  if (riErr) return { ok: false, message: riErr.message };
  if (Array.isArray(riRows) && riRows.length > 0) {
    return {
      ok: false,
      message: "Cannot mark empty box — physical items have already been scanned.",
    };
  }

  const { data: slipRows, error: slipErr } = await supabaseServer
    .from("slip_contents")
    .select("id, quantity")
    .eq("package_id", pkgId);
  if (slipErr) return { ok: false, message: slipErr.message };
  const expectedQty = (Array.isArray(slipRows) ? slipRows : []).reduce(
    (s, raw) => s + Math.max(0, Math.floor(Number((raw as { quantity?: unknown }).quantity ?? 0))),
    0,
  );
  const scannedQty = 0;

  const marked = await markOperatorSlipMissingExpectedAction({
    requestedOrganizationId: input.requestedOrganizationId,
    packageId: pkgId,
    storeId: input.storeId ?? null,
    note: input.note ?? "Empty box — no physical items received.",
  });
  if (!marked.ok) {
    // Slip lines may be absent — still allow empty box flag when no expected lines.
    if (!marked.message.includes("No slip lines") && !marked.message.includes("remaining missing")) {
      return marked;
    }
  }

  const { data: pkgRow, error: pkgSelErr } = await supabaseServer
    .from("packages")
    .select("id, manifest_data, notes")
    .eq("id", pkgId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgSelErr) return { ok: false, message: pkgSelErr.message };
  if (!pkgRow) return { ok: false, message: "Package not found for this organization." };

  const markedAt = new Date().toISOString();
  const manifest_data = mergePackageManifestEmptyBox(
    (pkgRow as { manifest_data?: unknown }).manifest_data,
    {
      markedAtIso: markedAt,
      markedBy: sessionUserId,
      expectedQty,
      scannedQty,
      note: input.note ?? "Empty box — no physical items received.",
    },
  );
  const priorNotes = String((pkgRow as { notes?: string | null }).notes ?? "").trim();
  const autoLine = "System Auto-Note: Empty box — no physical items received.";
  const notes = priorNotes ? `${priorNotes}\n${autoLine}` : autoLine;

  const { error: updErr } = await supabaseServer
    .from("packages")
    .update({ manifest_data, notes, updated_at: markedAt })
    .eq("id", pkgId);
  if (updErr) return { ok: false, message: updErr.message };

  return { ok: true };
}

// ─── Item scan finalize (package close — server owns qty + claim promotion) ───

export type FinalizeOperatorPackageItemScanInput = {
  requestedOrganizationId: string;
  packageId: string;
  storeId?: string | null;
  emptyBox?: boolean;
  notes?: string | null;
  evidenceRefs?: PackageItemScanEvidenceRefs | null;
  boxReviewSnapshot?: BoxCloseReviewSnapshot | null;
};

export type FinalizeOperatorPackageItemScanResult =
  | {
      ok: true;
      empty_box: boolean;
      expected_qty: number;
      scanned_qty: number;
      discrepancy: boolean;
    }
  | { ok: false; message: string };

function isMissingPackageStatusColumnError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    m.includes("42703") ||
    (m.includes("column") &&
      m.includes("status") &&
      (m.includes("does not exist") || m.includes("undefined column") || m.includes("schema cache")))
  );
}

/**
 * Finalize operator item scan: shortage = expected_qty - physical scanned return_items.
 * Operator missing review is confirmation metadata only — never creates return_items or false claims.
 */
export async function finalizeOperatorPackageItemScanAction(
  input: FinalizeOperatorPackageItemScanInput,
): Promise<FinalizeOperatorPackageItemScanResult> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const pkgId = String(input.packageId ?? "").trim();
  if (!isUuidString(pkgId)) {
    return { ok: false, message: "Invalid package id." };
  }

  const { data: pkgRow, error: pkgSelErr } = await supabaseServer
    .from("packages")
    .select(
      "id, organization_id, store_id, manifest_data, notes, outside_photo_urls, inside_photo_urls, slip_photo_urls, status",
    )
    .eq("id", pkgId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgSelErr) return { ok: false, message: pkgSelErr.message };
  if (!pkgRow) return { ok: false, message: "Package not found for this organization." };

  const scope = String(input.storeId ?? "").trim();
  const pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  if (scope && isUuidString(scope) && pkgStore && isUuidString(pkgStore) && pkgStore !== scope) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  const slipSelectAttempts = ["id, quantity"];
  let slipRes: { data: unknown; error: { message: string } | null } | null = null;
  for (const sel of slipSelectAttempts) {
    const r = await supabaseServer
      .from("slip_contents")
      .select(sel)
      .eq("package_id", pkgId)
      .order("sort_index", { ascending: true });
    slipRes = r;
    if (!r.error) break;
  }
  if (!slipRes || slipRes.error) {
    return { ok: false, message: slipRes?.error?.message ?? "slip_contents load failed." };
  }
  const slipLines = Array.isArray(slipRes.data) ? slipRes.data : [];

  const riLoad = await loadPackageReturnItemsForQtyBySlip(pkgId, organizationId, true);
  if (!riLoad.ok) return { ok: false, message: riLoad.message };
  const slipMatchRows = slipLinesToBarcodeMatchRows(slipLines);
  const { receivedBySlip, scannedQty } = computePackageScannedQtyBySlipFromReturnItems(
    riLoad.rows,
    slipMatchRows,
  );
  const riRows = riLoad.rows;

  const manifestData = (pkgRow as { manifest_data?: unknown }).manifest_data;
  const missingReviewEntries = readMissingReviewEntries(manifestData);
  const operatorMarkedTotal = missingReviewEntries.reduce(
    (s, e) => s + e.operator_marked_missing_qty,
    0,
  );

  let expectedQty = 0;
  for (const raw of slipLines) {
    const row = raw as Record<string, unknown>;
    const slipId = String(row.id ?? "").trim();
    const expected = Math.max(0, Math.floor(Number(row.quantity ?? 0)));
    expectedQty += expected;
    const received = slipId && isUuidString(slipId) ? (receivedBySlip.get(slipId) ?? 0) : 0;
    computeSlipLineExpectedVsReceived({
      expectedQty: expected,
      receivedQty: received,
      manifestRecordedMissingQty: missingReviewRecordedQtyForSlip(manifestData, slipId),
    });
  }

  const computedShortage = Math.max(0, expectedQty - scannedQty);
  const discrepancy = computedShortage > 0;
  const emptyBoxFlag =
    Boolean(input.emptyBox) || packageManifestHasEmptyBox(manifestData);

  const priorNotes = String(input.notes ?? (pkgRow as { notes?: string | null }).notes ?? "").trim();
  let notesOut = priorNotes;
  if (discrepancy) {
    const autoLine = `System Auto-Note: Discrepancy found (Expected ${expectedQty}, Scanned ${scannedQty})`;
    notesOut = priorNotes ? `${priorNotes}\n${autoLine}` : autoLine;
  } else if (emptyBoxFlag && !priorNotes.toLowerCase().includes("empty box")) {
    const autoLine = "System Auto-Note: Empty box — no physical items received.";
    notesOut = priorNotes ? `${priorNotes}\n${autoLine}` : autoLine;
  }

  const evidenceFromInput = input.evidenceRefs ?? null;
  const outsideFromPkg = sanitizePublicMediaUrlStrings(
    (pkgRow as { outside_photo_urls?: unknown }).outside_photo_urls,
    3,
  );
  const insideFromPkg = sanitizePublicMediaUrlStrings(
    (pkgRow as { inside_photo_urls?: unknown }).inside_photo_urls,
    3,
  );
  const slipFromPkg = sanitizePublicMediaUrlStrings(
    (pkgRow as { slip_photo_urls?: unknown }).slip_photo_urls,
    3,
  );
  const evidenceRefs: PackageItemScanEvidenceRefs = {
    outside_photo_urls:
      evidenceFromInput?.outside_photo_urls?.map((u) => String(u ?? "").trim()).filter(Boolean) ??
      outsideFromPkg,
    inside_photo_urls:
      evidenceFromInput?.inside_photo_urls?.map((u) => String(u ?? "").trim()).filter(Boolean) ??
      insideFromPkg,
    slip_photo_urls:
      evidenceFromInput?.slip_photo_urls?.map((u) => String(u ?? "").trim()).filter(Boolean) ??
      slipFromPkg,
  };

  const now = new Date().toISOString();
  const conflicts = detectMissingReviewConflicts({
    entries: missingReviewEntries,
    expectedQty,
    scannedQty,
    detectedAtIso: now,
  });

  let shortageSource: "system_detected" | "operator_confirmed" | "none" = "none";
  if (computedShortage > 0) {
    shortageSource = operatorMarkedTotal > 0 ? "operator_confirmed" : "system_detected";
  }

  const actor = await resolveAuditActorForSession();

  let manifest_data = mergePackageManifestItemScanFinalize(manifestData, {
    finalizedAtIso: now,
    emptyBox: emptyBoxFlag,
    evidenceRefs,
    boxReviewConfirmed: input.boxReviewSnapshot
      ? {
          confirmed_at: input.boxReviewSnapshot.confirmed_at,
          confirmed_by:
            input.boxReviewSnapshot.confirmed_by ??
            (actor.userId && isUuidString(actor.userId) ? actor.userId : null),
          bucket_counts: input.boxReviewSnapshot.bucket_counts,
          critical_issues_acknowledged: input.boxReviewSnapshot.critical_issues_acknowledged,
          audit_note: input.boxReviewSnapshot.audit_note,
          totals: input.boxReviewSnapshot.totals,
        }
      : undefined,
  });
  manifest_data = mergePackageManifestShortageFinalize(manifest_data, {
    expected_qty: expectedQty,
    scanned_qty: scannedQty,
    computed_shortage: computedShortage,
    shortage_source: shortageSource,
    operator_missing_review_attached: missingReviewEntries.length > 0,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
  });
  if (conflicts.length > 0) {
    manifest_data = mergePackageManifestMissingReviewConflicts(manifest_data, conflicts);
  }

  const pkgPatch: Record<string, unknown> = {
    manifest_data,
    notes: notesOut || null,
    updated_at: now,
    status: "closed",
  };
  if (actor.userId && isUuidString(actor.userId)) pkgPatch.updated_by = actor.userId;

  let { error: updErr } = await supabaseServer.from("packages").update(pkgPatch).eq("id", pkgId);
  if (updErr && isMissingPackageStatusColumnError(updErr.message)) {
    const { status: _s, ...withoutStatus } = pkgPatch;
    ({ error: updErr } = await supabaseServer.from("packages").update(withoutStatus).eq("id", pkgId));
  }
  if (updErr) return { ok: false, message: updErr.message };

  for (const raw of Array.isArray(riRows) ? riRows : []) {
    const rid = String((raw as { id?: string }).id ?? "").trim();
    if (!isUuidString(rid)) continue;
    await tryPromoteScannerClaimForReturnItem(rid, organizationId, sessionUserId);
  }

  return {
    ok: true,
    empty_box: emptyBoxFlag,
    expected_qty: expectedQty,
    scanned_qty: scannedQty,
    discrepancy,
  };
}

// ─── Item Soft Delete ─────────────────────────────────────────────────────────

function mapScannerDeleteRpcError(message: string): string {
  const m = String(message ?? "").trim().toLowerCase();
  if (m === "permission_denied") {
    return "You do not have permission to delete scanned units.";
  }
  if (m === "return_item_not_found") {
    return "Scanned item not found for this organization.";
  }
  if (m === "not_operator_mobile_scanned_unit") {
    return "Not an operator mobile scanned unit for this box.";
  }
  if (m === "active_claim_submission") {
    return "Cannot delete a scanned unit with an active claim submission.";
  }
  return message.trim() || "Could not delete scan record.";
}

async function assertOperatorMobileScannedUnitDeleteScope(input: {
  organizationId: string;
  userId: string;
  returnItemId: string;
  packageId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: row, error } = await supabaseServer
    .from(RETURN_ITEMS_TABLE)
    .select("id, organization_id, package_id, created_by, deleted_at")
    .eq("id", input.returnItemId)
    .eq("organization_id", input.organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!row) return { ok: false, error: OPERATOR_MOBILE_DELETE_ORG_MISMATCH_MESSAGE };

  const rowPackageId = String((row as { package_id?: string | null }).package_id ?? "").trim();
  if (!rowPackageId || !isUuidString(rowPackageId)) {
    return { ok: false, error: OPERATOR_MOBILE_DELETE_NOT_SCANNED_UNIT_MESSAGE };
  }
  if (rowPackageId !== input.packageId.trim()) {
    return { ok: false, error: OPERATOR_MOBILE_DELETE_NOT_SCANNED_UNIT_MESSAGE };
  }

  const elevated = await isElevatedOperatorMobileCorrectionRole(input.userId);
  const createdBy = String((row as { created_by?: string | null }).created_by ?? "").trim();
  if (!elevated && createdBy && isUuidString(createdBy) && createdBy !== input.userId) {
    return { ok: false, error: OPERATOR_MOBILE_DELETE_OWNERSHIP_MESSAGE };
  }

  return { ok: true };
}

/**
 * Soft-delete a single scanned item (return_items row) by setting deleted_at = NOW().
 * Follows the project's soft-delete convention — the row is recoverable via admin tools
 * within the configured undo window.
 */
/**
 * Soft-delete a single scanned item (return_items row) using the system's proper
 * soft-void pipeline: releases expected allocation and creates an undo batch.
 * Uses `softVoidReturnItemWithExpectedRelease` which calls the v2 cascade RPC with
 * TS fallback (handles missing migrations gracefully).
 */
export async function deleteOperatorPackageItemAction(input: {
  requestedOrganizationId: string;
  returnItemId: string;
  packageId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }
  const riId = String(input.returnItemId ?? "").trim();
  const pkgId = String(input.packageId ?? "").trim();
  if (!isUuidString(riId) || !isUuidString(pkgId)) {
    return { ok: false, error: "Invalid item or package id." };
  }

  const perm = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_DELETE_ITEM);
  if (!perm.ok) return { ok: false, error: perm.message };

  const scope = await assertOperatorMobileScannedUnitDeleteScope({
    organizationId,
    userId: perm.userId,
    returnItemId: riId,
    packageId: pkgId,
  });
  if (!scope.ok) return { ok: false, error: scope.error };

  const receiveGate = await assertPackageReceiveOpenForPackageEdits(organizationId, pkgId);
  if (!receiveGate.ok) return { ok: false, error: receiveGate.message };

  const actor = await resolveAuditActorForSession();
  const voided = await softVoidReturnItemWithExpectedRelease(supabaseServer, {
    returnItemId: riId,
    organizationId,
    updatedBy: actor.userId && isUuidString(actor.userId) ? actor.userId : perm.userId,
  });
  if (!voided.ok) return { ok: false, error: mapScannerDeleteRpcError(voided.error) };
  return { ok: true };
}

// ─── 6D receive-state correction + missing-review patch ─────────────────────

export type PatchPackageMissingReviewInput = {
  requestedOrganizationId: string;
  packageId: string;
  storeId?: string | null;
  slipContentId?: string | null;
  /** Adjust existing entry; `0` removes (undo). */
  operatorMarkedMissingQty?: number;
  /** Units to mark when creating a new entry. */
  missingQty?: number;
  note?: string | null;
};

/** 6D contract: single patch entry point for operator missing-review metadata. */
export async function patchPackageMissingReviewAction(
  input: PatchPackageMissingReviewInput,
): Promise<{ ok: true; updated?: number } | { ok: false; message: string }> {
  const pkgId = String(input.packageId ?? "").trim();
  const slipId = String(input.slipContentId ?? "").trim();
  const markedQtyRaw = input.operatorMarkedMissingQty;

  if (markedQtyRaw != null && Number.isFinite(Number(markedQtyRaw))) {
    const markedQty = Math.max(0, Math.floor(Number(markedQtyRaw)));
    if (markedQty === 0) {
      if (!slipId || !isUuidString(slipId)) {
        return { ok: false, message: "Invalid slip line id." };
      }
      return undoOperatorSlipMissingReviewAction({
        requestedOrganizationId: input.requestedOrganizationId,
        packageId: pkgId,
        storeId: input.storeId ?? null,
        slipContentId: slipId,
      });
    }
    if (!slipId || !isUuidString(slipId)) {
      return { ok: false, message: "Invalid slip line id." };
    }
    const edited = await editOperatorSlipMissingReviewAction({
      requestedOrganizationId: input.requestedOrganizationId,
      packageId: pkgId,
      storeId: input.storeId ?? null,
      slipContentId: slipId,
      operatorMarkedMissingQty: markedQty,
      note: input.note ?? null,
    });
    return edited.ok ? { ok: true } : edited;
  }

  return markOperatorSlipMissingExpectedAction({
    requestedOrganizationId: input.requestedOrganizationId,
    packageId: pkgId,
    storeId: input.storeId ?? null,
    slipContentId: slipId && isUuidString(slipId) ? slipId : null,
    missingQty: input.missingQty,
    note: input.note ?? null,
  });
}

export type ReopenOperatorPackageReceiveInput = {
  requestedOrganizationId: string;
  packageId: string;
  storeId?: string | null;
};

/** Reopen a finalized package receive for operator correction (manifest-only state flip). */
export async function reopenOperatorPackageReceiveAction(
  input: ReopenOperatorPackageReceiveInput,
): Promise<{ ok: true; receive_state: "open" } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const pkgId = String(input.packageId ?? "").trim();
  if (!isUuidString(pkgId)) {
    return { ok: false, message: "Invalid package id." };
  }

  const { data: pkgRow, error: pkgErr } = await supabaseServer
    .from("packages")
    .select("id, store_id, manifest_data, status")
    .eq("id", pkgId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgErr) return { ok: false, message: pkgErr.message };
  if (!pkgRow) return { ok: false, message: "Package not found for this organization." };

  const scope = String(input.storeId ?? "").trim();
  const pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  if (scope && isUuidString(scope) && pkgStore && isUuidString(pkgStore) && pkgStore !== scope) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  if (!packageReceiveStateIsFinalized((pkgRow as { manifest_data?: unknown }).manifest_data)) {
    return { ok: false, message: "Package receive is not finalized." };
  }

  const now = new Date().toISOString();
  const manifest_data = mergePackageManifestReceiveReopen(
    (pkgRow as { manifest_data?: unknown }).manifest_data,
    { reopenedAtIso: now, reopenedBy: sessionUserId },
  );

  const actor = await resolveAuditActorForSession();
  const pkgPatch: Record<string, unknown> = {
    manifest_data,
    updated_at: now,
    status: "received",
  };
  if (actor.userId && isUuidString(actor.userId)) pkgPatch.updated_by = actor.userId;

  let { error: updErr } = await supabaseServer.from("packages").update(pkgPatch).eq("id", pkgId);
  if (updErr && isMissingPackageStatusColumnError(updErr.message)) {
    const { status: _s, ...withoutStatus } = pkgPatch;
    ({ error: updErr } = await supabaseServer.from("packages").update(withoutStatus).eq("id", pkgId));
  }
  if (updErr) return { ok: false, message: updErr.message };

  return { ok: true, receive_state: "open" };
}

export type CorrectOperatorPackageItemQuantityInput = {
  requestedOrganizationId: string;
  returnItemId: string;
  storeId?: string | null;
  scannedQuantity: number;
};

/** Correction backend: adjust `return_items.scanned_quantity` with allocation release/re-allocate. */
export async function correctOperatorPackageItemQuantityAction(
  input: CorrectOperatorPackageItemQuantityInput,
): Promise<{ ok: true; scanned_quantity: number } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const returnItemId = String(input.returnItemId ?? "").trim();
  if (!isUuidString(returnItemId)) {
    return { ok: false, message: "Invalid return item id." };
  }

  const editPerm = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_EDIT_ITEM);
  if (!editPerm.ok) return { ok: false, message: editPerm.message };

  const newQtyRaw = Number(input.scannedQuantity ?? 1);
  const newQty = Number.isFinite(newQtyRaw) ? Math.max(1, Math.min(500, Math.floor(newQtyRaw))) : 1;

  const qtySelectAttempts = [
    "id, organization_id, store_id, package_id, scanned_quantity, quantity, expected_item_id",
    "id, organization_id, store_id, package_id, scanned_quantity, expected_item_id",
    "id, organization_id, store_id, package_id, scanned_quantity, quantity",
    "id, organization_id, store_id, package_id, scanned_quantity",
    "id, organization_id, store_id, package_id",
  ];
  let row: Record<string, unknown> | null = null;
  let loadErr: { message: string } | null = null;
  for (const sel of qtySelectAttempts) {
    const r = await supabaseServer
      .from(RETURN_ITEMS_TABLE)
      .select(sel)
      .eq("id", returnItemId)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .maybeSingle();
    loadErr = r.error;
    if (!r.error && r.data && typeof r.data === "object") {
      row = r.data as Record<string, unknown>;
      break;
    }
    if (r.error && !/column.*does not exist|42703|schema cache/i.test(r.error.message)) break;
  }
  if (loadErr && !row) return { ok: false, message: loadErr.message };
  if (!row) return { ok: false, message: "Scanned item not found." };

  const scope = String(input.storeId ?? "").trim();
  const rowStore = String((row as { store_id?: string | null }).store_id ?? "").trim();
  if (scope && isUuidString(scope) && rowStore && isUuidString(rowStore) && rowStore !== scope) {
    return { ok: false, message: "This item belongs to another store — select the correct store." };
  }

  const oldQty = returnItemUnitQty(row as Record<string, unknown>);
  if (oldQty === newQty) {
    return { ok: true, scanned_quantity: newQty };
  }

  const packageId = String((row as { package_id?: string | null }).package_id ?? "").trim();
  if (String((row as { expected_item_id?: string | null }).expected_item_id ?? "").trim()) {
    const released = await releaseExpectedItemUnit(supabaseServer, {
      returnItemId,
      organizationId,
      softDelete: false,
    });
    if (!released.ok) return { ok: false, message: released.error };
  }

  const now = new Date().toISOString();
  const actor = await resolveAuditActorForSession();
  const patch: Record<string, unknown> = {
    scanned_quantity: newQty,
    updated_at: now,
  };
  if (actor.userId && isUuidString(actor.userId)) patch.updated_by = actor.userId;

  const { error: upErr } = await supabaseServer
    .from(RETURN_ITEMS_TABLE)
    .update(patch)
    .eq("id", returnItemId)
    .eq("organization_id", organizationId);
  if (upErr) {
    const guarded = guardBatchQuantityBackendError(newQty, upErr.message);
    return { ok: false, message: guarded ?? upErr.message };
  }

  if (packageId && isUuidString(packageId)) {
    const pkgCtx = await fetchPackageReceiveContext(supabaseServer, packageId);
    const receiveScopeKey = buildReceiveScopeKey({
      organizationId,
      storeId: rowStore,
      packageId,
      slipCode: pkgCtx.slipCode,
    });
    const alloc = await allocateExpectedItemsForReturnItemIds(supabaseServer, {
      returnItemIds: [returnItemId],
      receiveScopeKey,
    });
    if (!alloc.ok && !isNoAllocatableExpectedAllocationError(alloc.error)) {
      return { ok: false, message: alloc.error };
    }
  }

  await supabaseServer.from("return_audit_log").insert({
    organization_id: organizationId,
    return_id: returnItemId,
    pallet_id: null,
    action: "updated",
    field: "scanner_quantity_correction",
    old_value: String(oldQty),
    new_value: String(newQty),
    actor: sessionUserId,
  });

  return { ok: true, scanned_quantity: newQty };
}

export type CorrectOperatorPackageItemProductInput = {
  requestedOrganizationId: string;
  returnItemId: string;
  resolvedProductId: string;
  storeId?: string | null;
};

/** Correction backend: manual product resolution override (no product create/merge). */
export async function correctOperatorPackageItemProductAction(
  input: CorrectOperatorPackageItemProductInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const gate = await assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_EDIT_ITEM);
  if (!gate.ok) return { ok: false, message: gate.message };

  const res = await manualOverrideReturnItemProductResolution({
    return_item_id: input.returnItemId,
    resolved_product_id: input.resolvedProductId,
    actor_profile_id: sessionUserId,
    actor: "operator_correction",
  });
  if (!res.ok) return { ok: false, message: res.error ?? "Product correction failed." };
  return { ok: true };
}
