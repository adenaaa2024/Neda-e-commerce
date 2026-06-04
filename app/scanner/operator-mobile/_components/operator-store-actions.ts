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
import type { OperatorStoreOption } from "@/lib/scanner/operator-session";
import {
  findPalletByIdForOperator,
  findPalletByTrackingOrNumber,
  findPalletInOrgByScanCode,
  type OperatorPalletTrackingRow,
} from "@/lib/scanner/operator-pallet-tracking";
import {
  assertOperatorMobilePermission,
  userHasOperatorMobilePermission,
} from "@/lib/operator-mobile-permission-guard";
import {
  OPERATOR_MOBILE_MOVE_BOX,
  OPERATOR_MOBILE_VOID_BOX,
} from "@/lib/operator-mobile-permissions";
import { softDeleteShipmentEntryBaselineReturnItems } from "@/lib/scanner/operator-active-scanned-counts";
import { shouldExcludeReturnItemFromScannerCounts } from "@/lib/scanner/return-items-test-data-guard";
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
  moveExpectedItemsForPackageScope,
  releaseExpectedItemsForPackage,
  resolveAllocatableExpectedPackageHint,
  softVoidPalletWithExpectedRelease,
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
  mergeReturnPhotoEvidence,
  getReturnPhotoEvidenceGalleryUrls,
  getReturnPhotoEvidenceUrls,
  type ReturnPhotoEvidenceRow,
} from "@/lib/return-photo-evidence";
import {
  ITEM_UNIT_SELLABLE_OK_TAG,
  normalizeItemUnitDiscrepancySelection,
  type ItemUnitDiscrepancyTagKey,
} from "@/lib/scanner/item-unit-discrepancy-tags";
import {
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
      "id, package_code, tracking_number, order_id, id_slip_contents, notes, outside_photo_urls, inside_photo_urls, slip_photo_urls, expected_item_count, actual_item_count, created_at, updated_at, created_by, updated_by",
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

/** PostgREST when `slip_contents.notes` exists in app but not yet migrated on the project DB. */
function isMissingSlipContentsNotesSchemaError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    m.includes("slip_contents") &&
    m.includes("notes") &&
    (m.includes("schema cache") || m.includes("could not find") || m.includes("column"))
  );
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
    "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes, order_id, conflicting_order_id, resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence",
    "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes, order_id, conflicting_order_id",
    "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes, conflicting_order_id",
    "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes, order_id",
    "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes",
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
      fnsku: typeof r.fnsku === "string" && r.fnsku.trim() ? r.fnsku.trim() : null,
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
          notes: line.missing ? JSON.stringify({ missing: true }) : null,
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
        if (isMissingSlipContentsNotesSchemaError(msg)) {
          insertRows = insertRows.map(({ notes: _n, ...rest }) => rest);
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

export type OperatorPackageItemRow = {
  id: string;
  slip_content_id: string | null;
  scanned_barcode: string;
  match_kind: "fnsku" | "upc" | "unexpected";
  quantity: number;
  discrepancy_tags: string[] | null;
  expiry_date: string | null;
  lot_number: string | null;
  evidence_urls: string[] | null;
  optional_item_photo_url: string | null;
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
    optional_item_photo_url: string | null;
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
    const slip_content_id = slipContentIdForReturnItemBarcode(scanned_barcode, slipMatchRows);
    const match_kind = inferMatchKindFromReturnItemRow({ fnsku, sku, product_identifier });
    const dt = Array.isArray(row.conditions)
      ? row.conditions.map((x) => String(x ?? "").trim()).filter(Boolean)
      : null;
    const pe = (row.photo_evidence ?? null) as ReturnPhotoEvidenceRow;
    const urlSlots = getReturnPhotoEvidenceUrls(pe);
    const optionalItem =
      urlSlots.item_url && /^https?:\/\//i.test(urlSlots.item_url) ? urlSlots.item_url : null;
    const ev = getReturnPhotoEvidenceGalleryUrls(pe);
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
      evidence_urls: ev.length ? ev : null,
      optional_item_photo_url: optionalItem,
      operator_notes:
        typeof row.notes === "string" && row.notes.trim() ? row.notes.trim().slice(0, 2000) : null,
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
  /** Optional item photo URL (stored in `photo_evidence.item_url`). */
  optionalItemPhotoUrl?: string | null;
  /** When true, expiry date + lot # are required (perishable / grocery path). */
  traceabilityRequired?: boolean;
  /** Operator prose note (`return_items.notes`). */
  operatorNotes?: string | null;
  /** Client/server hint — parent `expected_packages.id` with remaining qty (Item Scan slip row). */
  expectedPackageHintId?: string | null;
  /** Loose item (no box) — writes `return_items` without `package_id`. */
  looseItem?: boolean;
  /** Step 2 fallback — return label on packaging (loose flow). */
  returnLabelPhotoUrl?: string | null;
};

function normalizeEvidenceUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const u of raw) {
    const s = String(u ?? "").trim().slice(0, 2000);
    if (s && /^https?:\/\//i.test(s) && out.length < 24) out.push(s);
  }
  return out;
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

    const alloc = await allocateExpectedItemsForReturnItemIds(supabaseServer, {
      returnItemIds: [rid],
      receiveScopeKey,
      expectedPackageHintId: expectedHint && isUuidString(expectedHint) ? expectedHint : null,
      errorContext: { fnsku: allocFnsku, sku: allocSku, slipCode, trackingNumber },
    });
    if (!alloc.ok) {
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
  const pattern = `%${q.replace(/%/g, "").replace(/_/g, "")}%`;

  try {
    let data: unknown = null;
    let error: { message: string } | null = null;
    const primary = await supabaseServer
      .from("products")
      .select("id, product_name, name, sku, fnsku, asin")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .or(`product_name.ilike.${pattern},name.ilike.${pattern},sku.ilike.${pattern},fnsku.ilike.${pattern},asin.ilike.${pattern}`)
      .limit(limit);
    data = primary.data;
    error = primary.error;
    if (error) {
      const fallback = await supabaseServer
        .from("products")
        .select("id, name, sku, fnsku, asin")
        .eq("organization_id", organizationId)
        .eq("store_id", storeId)
        .or(`name.ilike.${pattern},sku.ilike.${pattern},fnsku.ilike.${pattern},asin.ilike.${pattern}`)
        .limit(limit);
      data = fallback.data;
      error = fallback.error;
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
 * Insert one item-scan unit as a `return_items` row (`packages.actual_item_count` via DB trigger).
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
  if (tags.length === 0) {
    return { ok: false, message: "Select at least one condition for this unit." };
  }

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
  const optionalItemUrl = String(input.optionalItemPhotoUrl ?? "").trim();
  const returnLabelUrl = String(input.returnLabelPhotoUrl ?? "").trim();
  const urlSlots: Partial<Record<"item_url" | "return_label_url", string>> = {};
  if (optionalItemUrl && /^https?:\/\//i.test(optionalItemUrl)) urlSlots.item_url = optionalItemUrl;
  if (returnLabelUrl && /^https?:\/\//i.test(returnLabelUrl)) urlSlots.return_label_url = returnLabelUrl;
  const photo_evidence = mergeReturnPhotoEvidence(null, urlSlots, { galleryUrls: evidence });

  const operatorNotes = String(input.operatorNotes ?? "").trim().slice(0, 2000) || null;

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
  if (!looseItem && pkgId && (!expectedPackageHintId || !isUuidString(expectedPackageHintId))) {
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
  });

  if (!ins.ok || !ins.data?.id) {
    return { ok: false, message: ins.error ?? "Failed to save item scan." };
  }

  const primaryId = ins.data.id;
  const insertedIds: string[] = [primaryId];

  const finalizeLinkageParams = {
    organizationId,
    storeId: storeIdResolved,
    packageId: looseItem ? null : pkgId,
    looseItem,
    slipLinkage: slipLinkageInherit,
    slipContentId: slipHint && isUuidString(slipHint) ? slipHint : null,
    slipExpectedQuantity,
    expectedPackageHintId: isUuidString(expectedPackageHintId) ? expectedPackageHintId : null,
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

  if (quantity > 1) {
    for (let i = 1; i < quantity; i++) {
      const extra = await insertReturn({
        ...insertReturnBase,
        package_id: looseItem ? undefined : pkgId ?? undefined,
        fnsku: scanIds.fnsku?.slice(0, 500),
        sku: scanIds.sku?.slice(0, 500),
        asin: scanIds.asin?.slice(0, 500),
        product_identifier: scanIds.upc?.slice(0, 500),
      });
      if (!extra.ok || !extra.data?.id) {
        await rollbackOperatorPackageReturnItemsOnAllocationFailure(insertedIds);
        return { ok: false, message: extra.error ?? "Failed to save item scan." };
      }
      insertedIds.push(extra.data.id);
      const finalizeExtra = await finalizeOperatorPackageItemLinkage(extra.data.id, finalizeLinkageParams);
      if (!finalizeExtra.ok) {
        await rollbackOperatorPackageReturnItemsOnAllocationFailure(insertedIds);
        return { ok: false, message: finalizeExtra.error };
      }
      await tryPromoteScannerClaimForReturnItem(extra.data.id, organizationId, sessionUserId);
    }
  }

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

export type OperatorMobileCorrectionPermissions = {
  moveBox: boolean;
  voidBox: boolean;
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
  const [moveBox, voidBox] = await Promise.all([
    userHasOperatorMobilePermission(sessionUserId, organizationId, OPERATOR_MOBILE_MOVE_BOX),
    userHasOperatorMobilePermission(sessionUserId, organizationId, OPERATOR_MOBILE_VOID_BOX),
  ]);
  return { ok: true, permissions: { moveBox, voidBox } };
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

  const tags = normalizeItemUnitDiscrepancySelection(
    filterPackageItemDiscrepancyTags(input.discrepancyTags),
  );
  if (tags.length === 0) {
    return { ok: false, message: "Select at least one condition for this unit." };
  }

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

  const optionalItemUrl = String(input.optionalItemPhotoUrl ?? "").trim();
  const urlSlots: Partial<Record<"item_url", string>> = {};
  if (optionalItemUrl && /^https?:\/\//i.test(optionalItemUrl)) urlSlots.item_url = optionalItemUrl;
  const photo_evidence = mergeReturnPhotoEvidence(null, urlSlots, { galleryUrls: evidence });

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
  opts?: { skipExpensiveFallback?: boolean },
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
 * update each scanned return_items row for the package:
 * - Items whose barcode (fnsku / sku / product_identifier) matches a new slip line →
 *   receive the new slip_content_id + slip_code.
 * - Items that do NOT match any new slip line → slip_content_id = null, slip_code = null.
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

  const RETURN_ITEMS_TABLE = "return_items";

  try {
    // Load new slip_contents for this package (after save)
    const { data: newSlipRows, error: slipErr } = await supabaseServer
      .from("slip_contents")
      .select("id, fnsku, upc, slip_code")
      .eq("package_id", pkgId)
      .is("deleted_at", null);
    if (slipErr) return { ok: false, matched: 0, unlinked: 0, error: slipErr.message };

    // Build lookup: barcode → slip_content_id for fast matching
    type SlipMatch = { id: string; slip_code: string | null };
    const byFnsku = new Map<string, SlipMatch>();
    const byUpc = new Map<string, SlipMatch>();
    for (const row of newSlipRows ?? []) {
      const match: SlipMatch = { id: String(row.id), slip_code: String(row.slip_code ?? input.newSlipCode ?? "") || null };
      const fnsku = String(row.fnsku ?? "").trim().toUpperCase();
      const upc = String(row.upc ?? "").trim();
      if (fnsku) byFnsku.set(fnsku, match);
      if (upc) byUpc.set(upc, match);
    }

    // Load scanned return_items for this package
    const { data: items, error: riErr } = await supabaseServer
      .from(RETURN_ITEMS_TABLE)
      .select("id, fnsku, sku, product_identifier")
      .eq("package_id", pkgId)
      .eq("organization_id", organizationId)
      .is("deleted_at", null);
    if (riErr) return { ok: false, matched: 0, unlinked: 0, error: riErr.message };

    let matched = 0;
    let unlinked = 0;

    for (const item of items ?? []) {
      const fnsku = String(item.fnsku ?? "").trim().toUpperCase();
      const upc = String(item.product_identifier ?? item.sku ?? "").trim();
      const slip = byFnsku.get(fnsku) ?? byUpc.get(upc) ?? null;

      if (slip) {
        await supabaseServer
          .from(RETURN_ITEMS_TABLE)
          .update({ slip_content_id: slip.id, slip_code: slip.slip_code })
          .eq("id", item.id)
          .eq("organization_id", organizationId);
        matched++;
      } else {
        await supabaseServer
          .from(RETURN_ITEMS_TABLE)
          .update({ slip_content_id: null, slip_code: null })
          .eq("id", item.id)
          .eq("organization_id", organizationId);
        unlinked++;
      }
    }

    return { ok: true, matched, unlinked };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    return { ok: false, matched: 0, unlinked: 0, error: msg };
  }
}

// ─── Item Soft Delete ─────────────────────────────────────────────────────────

/**
 * Soft-delete a single scanned item (return_items row) by setting deleted_at = NOW().
 * Follows the project's soft-delete convention — the row is recoverable via admin tools
 * within the configured undo window.
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

  try {
    const { error } = await supabaseServer
      .from("return_items")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", riId)
      .eq("package_id", pkgId)
      .eq("organization_id", organizationId)
      .is("deleted_at", null);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}
