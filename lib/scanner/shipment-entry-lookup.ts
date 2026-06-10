import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isStrongShipmentIdentityMatchType,
  probePackageSlipRmaFast,
  shouldTryLimitedBarcodeProbe,
  type ScannerIdentityGateMatchType,
} from "@/lib/search/shipment-identity-gate";
import {
  fetchExpectedPackageDetailRowsForParent,
  fetchExpectedPackagesForTracking,
  isLikelyShipmentTrackingCode,
  mockExpectedPackageDetailRows,
  type FetchExpectedPackagesOptions,
} from "@/lib/scanner/operator-tracking-expectations";
import {
  mockResolveOperatorBarcode,
  resolveOperatorBarcode,
  type OperatorResolveKind,
  type OperatorResolveResult,
} from "@/lib/scanner/operator-resolve-barcode";
import { trackingKeysEqual } from "@/lib/scanner/tracking-normalize";
import { scrubInventoryRowsExcludingVoidedPackages } from "@/lib/scanner/operator-active-scanned-counts";
import {
  aggregateInventoryStatus,
  fetchVInventoryStatusForScanCode,
  mockVInventoryRowsForScanCode,
  resolveInventoryGateVisualStatus,
  type InventoryGateVisualStatus,
  type InventoryViewMatchField,
  type VInventoryStatusRow,
} from "@/lib/scanner/v-inventory-status";

export { isStrongShipmentIdentityMatchType };

/** Normalize operator scan input (BOM / zero-width / outer whitespace). */
export function normalizeShipmentEntryScanCode(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^[\s\uFEFF\xA0\u200B-\u200D]+|[\s\uFEFF\xA0\u200B-\u200D]+$/g, "");
}

export type ShipmentEntryMatchStatus =
  | "found_tracking"
  | "found_slip"
  | "found_package"
  | "found_pallet"
  | "expected_only"
  | "already_scanned"
  | "not_found"
  | "ambiguous";

export type ShipmentEntryEntityType =
  | "tracking"
  | "slip"
  | "package"
  | "box"
  | "pallet"
  | "container"
  | "expected_package"
  | "unknown";

export type ShipmentEntryNextAction =
  | "continue_to_package"
  | "continue_to_pallet"
  | "create_orphan"
  | "review_ambiguous"
  | "show_not_found";

/** Stable gate response shape (V204) — maps from {@link ShipmentEntryLookupResult}. */
export type ShipmentEntryGateResult = {
  code: string;
  normalized_code: string;
  found: boolean;
  source:
    | "v_inventory_status"
    | "v_inventory_item_status"
    | "expected_packages"
    | "packages"
    | "pallets"
    | "shipment_boxes"
    | "shipment_containers"
    | "none";
  entity_type:
    | "tracking"
    | "slip"
    | "package"
    | "box"
    | "pallet"
    | "container"
    | "unknown";
  manifest_status:
    | "expected"
    | "received"
    | "partially_scanned"
    | "already_scanned"
    | "not_registered"
    | "off_manifest"
    | "ambiguous";
  expected_count?: number;
  scanned_count?: number;
  package_code?: string | null;
  tracking_number?: string | null;
  slip_code?: string | null;
  package_id?: string | null;
  pallet_id?: string | null;
  next_action:
    | "continue_existing"
    | "resume_package"
    | "resume_pallet"
    | "create_new"
    | "review_ambiguous";
};

export type ShipmentEntryLookupResult = {
  normalized_code: string;
  match_status: ShipmentEntryMatchStatus;
  entity_type: ShipmentEntryEntityType;
  entity_id: string | null;
  package_id?: string | null;
  pallet_id?: string | null;
  shipment_box_id?: string | null;
  shipment_container_id?: string | null;
  expected_package_id?: string | null;
  tracking_number?: string | null;
  slip_code?: string | null;
  package_code?: string | null;
  status_label: string;
  status_detail?: string | null;
  next_action: ShipmentEntryNextAction;
  /** Inventory view rows driving the gate table (never product resolver). */
  inventory_rows: VInventoryStatusRow[];
  inventory_matched_field: InventoryViewMatchField | null;
  inventory_visual: InventoryGateVisualStatus;
  /** Raw barcode resolution (tracking / package / slip / pallet only — never item). */
  barcode: OperatorResolveResult;
  canonical_tracking: string | null;
  /** Phase 9D RPC match_type when identity gate resolved the code shape but rows may be empty. */
  identity_match_type?: ScannerIdentityGateMatchType | null;
  /** True only when fast-negative path explicitly confirmed off-manifest (not RPC shape-only). */
  gate_fast_negative_confirmed?: boolean;
  /** Dev/audit timing for Shipment Entry gate (Phase 9H). */
  gate_timing?: {
    rpc_ms: number;
    fallback_ms: number;
    total_ms: number;
    fallback_reason: string | null;
  };
};

const SHIPMENT_ENTRY_RESOLVE_ORDER: OperatorResolveKind[] = ["tracking", "package", "slip", "pallet"];
const SHIPMENT_ENTRY_LIMITED_RESOLVE_ORDER: OperatorResolveKind[] = ["package", "slip"];

/** Gate fast path: one indexed package/slip probe for short codes only — skip for long unknown strings. */
/** Zero manifest rows — off manifest / add-as-new (excludes RPC match_type-only until fast-negative confirmed). */
export function isShipmentEntryOffManifest(lookup: ShipmentEntryLookupResult): boolean {
  if (lookup.inventory_rows.length > 0) return false;
  if (lookup.inventory_matched_field) return false;
  if (isStrongShipmentIdentityMatchType(lookup.identity_match_type)) {
    return Boolean(lookup.gate_fast_negative_confirmed);
  }
  if (lookup.barcode.kind === "package" || lookup.barcode.kind === "slip" || lookup.barcode.kind === "pallet") {
    return true;
  }
  if (lookup.barcode.kind !== "unknown") return false;
  return lookup.match_status === "not_found";
}

/** Fast negative: RPC or gate lookup finished with no manifest rows — skip post-gate hydration. */
export function isShipmentEntryFastNegative(lookup: ShipmentEntryLookupResult): boolean {
  return lookup.inventory_rows.length === 0 && isShipmentEntryOffManifest(lookup);
}

function manifestStatusFromLookup(r: ShipmentEntryLookupResult): ShipmentEntryGateResult["manifest_status"] {
  if (isShipmentEntryOffManifest(r)) return "off_manifest";
  if (r.match_status === "ambiguous") return "ambiguous";
  if (r.match_status === "expected_only") return "expected";
  if (r.match_status === "already_scanned") return "already_scanned";
  if (r.inventory_visual === "in_progress") return "partially_scanned";
  if (r.inventory_visual === "completed" || r.inventory_visual === "over_scanned") return "already_scanned";
  if (r.inventory_visual === "new" || r.inventory_visual === "unexpected") return "received";
  return "expected";
}

function gateSourceFromLookup(r: ShipmentEntryLookupResult): ShipmentEntryGateResult["source"] {
  if (isShipmentEntryOffManifest(r)) return "none";
  if (r.inventory_rows.length > 0) {
    return "expected_packages";
  }
  if (r.barcode.kind === "package" || r.barcode.kind === "slip") return "packages";
  if (r.barcode.kind === "pallet") return "pallets";
  if (r.barcode.kind === "tracking" || r.expected_package_id) return "expected_packages";
  return "none";
}

function gateNextActionFromLookup(r: ShipmentEntryLookupResult): ShipmentEntryGateResult["next_action"] {
  if (isShipmentEntryOffManifest(r)) return "create_new";
  if (r.next_action === "review_ambiguous") return "review_ambiguous";
  if (r.next_action === "continue_to_pallet") return "resume_pallet";
  if (r.next_action === "continue_to_package") return "resume_package";
  return "continue_existing";
}

export function toShipmentEntryGateResult(
  rawCode: string,
  r: ShipmentEntryLookupResult,
): ShipmentEntryGateResult {
  const agg = aggregateInventoryStatus(r.inventory_rows);
  const entity =
    r.entity_type === "expected_package"
      ? "tracking"
      : r.entity_type === "box"
        ? "package"
        : r.entity_type === "container"
          ? "container"
          : r.entity_type;
  return {
    code: rawCode,
    normalized_code: r.normalized_code,
    found: !isShipmentEntryOffManifest(r),
    source: gateSourceFromLookup(r),
    entity_type: entity,
    manifest_status: manifestStatusFromLookup(r),
    expected_count: agg.totalExpected,
    scanned_count: agg.totalScanned,
    package_code: r.package_code ?? null,
    tracking_number: r.tracking_number ?? null,
    slip_code: r.slip_code ?? null,
    package_id: r.package_id ?? null,
    pallet_id: r.pallet_id ?? null,
    next_action: gateNextActionFromLookup(r),
  };
}

function visualFromBarcodeRow(barcode: OperatorResolveResult): InventoryGateVisualStatus | null {
  if (barcode.kind === "unknown") return null;
  const row = barcode.row;
  const te = Math.max(
    0,
    Number(row.expected_item_count ?? row.expected_scan_quantity ?? row.total_expected ?? 0) || 0,
  );
  const ts = Math.max(
    0,
    Number(row.actual_item_count ?? row.actual_scanned_count ?? row.total_scanned ?? 0) || 0,
  );
  return resolveInventoryGateVisualStatus(
    [
      {
        expected_package_id: "",
        organization_id: "",
        store_id: "",
        tracking_number: null,
        id_slip_contents: null,
        sku: null,
        fnsku: null,
        asin: null,
        order_id: null,
        status: null,
        product_name: null,
        product_display_name: null,
        product_id: null,
        resolved_product_id: null,
        resolved_catalog_product_id: null,
        product_linkage_status: null,
        identifier_resolution_status: null,
        identifier_resolution_confidence: null,
        carrier: null,
        total_expected: te,
        total_scanned: ts,
      },
    ],
    { rowCount: 1, totalExpected: te, totalScanned: ts },
  );
}

const PACKAGE_PROBE_SELECT =
  "id, organization_id, pallet_id, package_code, id_slip_contents, tracking_number, rma_number, expected_item_count, actual_item_count, status";

/** Indexed package_code / slip probes only — single round trip, no tracking ILIKE scan (Phase 9H). */
async function resolveShipmentEntryBarcodeIndexedFast(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  code: string,
): Promise<OperatorResolveResult> {
  const trimmed = code.trim();
  const probe = await probePackageSlipRmaFast(supabase, organizationId, storeId, trimmed);
  if (!probe.found || !probe.package_id) return { kind: "unknown", code: trimmed };

  const { data, error } = await supabase
    .from("packages")
    .select(PACKAGE_PROBE_SELECT)
    .eq("id", probe.package_id)
    .is("deleted_at", null)
    .limit(1);
  if (error) throw error;
  const row = data?.[0] as Record<string, unknown> | undefined;
  if (!row) return { kind: "unknown", code: trimmed };

  const pkgCode = String(row.package_code ?? "").trim();
  const slipId = String(row.id_slip_contents ?? "").trim();
  const rma = String(row.rma_number ?? "").trim();
  if (pkgCode === trimmed || slipId === trimmed) {
    return { kind: "package", row };
  }
  if (rma === trimmed) return { kind: "slip", row };
  return { kind: "package", row };
}

async function resolveShipmentEntryBarcode(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  code: string,
  opts?: FetchExpectedPackagesOptions,
  order: OperatorResolveKind[] = SHIPMENT_ENTRY_RESOLVE_ORDER,
): Promise<OperatorResolveResult> {
  for (const only of order) {
    const r = await resolveOperatorBarcode(supabase, organizationId, code, {
      only,
      storeId,
      fetchOptions: opts,
    });
    if (r.kind !== "unknown") return r;
  }
  return { kind: "unknown", code };
}

function buildFastNegativeShipmentLookup(
  normalized_code: string,
  identityMatchType: ScannerIdentityGateMatchType | null,
): ShipmentEntryLookupResult {
  const emptyAgg = aggregateInventoryStatus([]);
  const detail = identityMatchType
    ? `Identity matched as ${identityMatchType} with no manifest lines.`
    : "No tracking, slip, package, or pallet match for this store.";
  return {
    normalized_code,
    match_status: "not_found",
    entity_type: "unknown",
    entity_id: null,
    status_label: identityMatchType ? "Not in this shipment" : "Not found",
    status_detail: detail,
    next_action: "show_not_found",
    inventory_rows: [],
    inventory_matched_field: null,
    inventory_visual: "manual_new",
    barcode: { kind: "unknown", code: normalized_code },
    canonical_tracking: null,
    identity_match_type: identityMatchType,
    gate_fast_negative_confirmed: true,
  };
}

function epRowToInventoryStatusRow(
  r: Record<string, unknown>,
  orgId: string,
  storeId: string,
): VInventoryStatusRow {
  return {
    expected_package_id: String((r as { id?: string }).id ?? ""),
    organization_id: orgId,
    store_id: storeId,
    tracking_number:
      (r as { tracking_number?: string | null }).tracking_number != null
        ? String((r as { tracking_number?: string | null }).tracking_number)
        : null,
    id_slip_contents:
      (r as { id_slip_contents?: string | null }).id_slip_contents != null
        ? String((r as { id_slip_contents?: string | null }).id_slip_contents)
        : (r as { slip_code?: string | null }).slip_code != null
          ? String((r as { slip_code?: string | null }).slip_code)
          : null,
    sku: (r as { sku?: string | null }).sku != null ? String((r as { sku?: string | null }).sku) : null,
    fnsku: (r as { fnsku?: string | null }).fnsku != null ? String((r as { fnsku?: string | null }).fnsku) : null,
    asin: (r as { asin?: string | null }).asin != null ? String((r as { asin?: string | null }).asin) : null,
    order_id:
      (r as { order_id?: string | null }).order_id != null
        ? String((r as { order_id?: string | null }).order_id)
        : null,
    status: null,
    product_name: null,
    product_display_name: null,
    product_id: (r as { product_id?: string | null }).product_id ?? null,
    resolved_product_id: (r as { resolved_product_id?: string | null }).resolved_product_id ?? null,
    resolved_catalog_product_id:
      (r as { resolved_catalog_product_id?: string | null }).resolved_catalog_product_id ?? null,
    product_linkage_status:
      (r as { identifier_resolution_status?: string | null }).identifier_resolution_status ?? null,
    identifier_resolution_status:
      (r as { identifier_resolution_status?: string | null }).identifier_resolution_status ?? null,
    identifier_resolution_confidence:
      (r as { identifier_resolution_confidence?: number | null }).identifier_resolution_confidence ?? null,
    carrier: null,
    total_expected: Number((r as { expected_scan_quantity?: number }).expected_scan_quantity ?? 0) || 0,
    total_scanned: Number((r as { actual_scanned_count?: number }).actual_scanned_count ?? 0) || 0,
  };
}

async function inventoryRowsFromExpectedPackagesFallback(
  supabase: SupabaseClient,
  orgId: string,
  storeId: string,
  trimmed: string,
): Promise<{ rows: VInventoryStatusRow[]; matchedField: InventoryViewMatchField | null }> {
  const epFallback = await fetchExpectedPackageDetailRowsForParent(supabase, orgId, storeId, {
    trackingNumber: trimmed,
    palletId: null,
  });
  const safeEp = Array.isArray(epFallback) ? epFallback : [];
  const exactEp = safeEp.filter((r) =>
    trackingKeysEqual((r as { tracking_number?: string | null }).tracking_number, trimmed),
  );
  if (!exactEp.length) return { rows: [], matchedField: null };
  return {
    rows: exactEp.map((r) => epRowToInventoryStatusRow(r as Record<string, unknown>, orgId, storeId)),
    matchedField: "tracking_number",
  };
}

function trackingFromBarcode(barcode: OperatorResolveResult): string | null {
  if (barcode.kind === "unknown") return null;
  const row = barcode.row;
  if (barcode.kind === "tracking") return String(row.tracking_number ?? "").trim() || null;
  if (barcode.kind === "package" || barcode.kind === "slip") {
    return String(row.tracking_number ?? "").trim() || null;
  }
  if (barcode.kind === "pallet") return String(row.tracking_number ?? "").trim() || null;
  return null;
}

function statusLabelForVisual(visual: InventoryGateVisualStatus): string {
  switch (visual) {
    case "new":
      return "New";
    case "manual_new":
      return "Unexpected";
    case "unexpected":
      return "Unexpected";
    case "in_progress":
      return "In progress";
    case "completed":
      return "Completed";
    case "over_scanned":
      return "Over scanned";
    default:
      return "Unknown";
  }
}

function deriveMatchMetadata(
  barcode: OperatorResolveResult,
  invRows: VInventoryStatusRow[],
  invField: InventoryViewMatchField | null,
  visual: InventoryGateVisualStatus,
  normalized: string,
): Pick<
  ShipmentEntryLookupResult,
  | "match_status"
  | "entity_type"
  | "entity_id"
  | "package_id"
  | "pallet_id"
  | "expected_package_id"
  | "tracking_number"
  | "slip_code"
  | "package_code"
  | "status_label"
  | "status_detail"
  | "next_action"
  | "canonical_tracking"
> {
  const firstInv = invRows[0];
  const canon =
    invRows.map((r) => String(r.tracking_number ?? "").trim()).find(Boolean) ??
    trackingFromBarcode(barcode) ??
    normalized;

  if (barcode.kind === "pallet") {
    return {
      match_status: "found_pallet",
      entity_type: "pallet",
      entity_id: String(barcode.row.id ?? "").trim() || null,
      package_id: null,
      pallet_id: String(barcode.row.id ?? "").trim() || null,
      expected_package_id: firstInv?.expected_package_id ?? null,
      tracking_number: canon,
      slip_code: null,
      package_code: null,
      status_label: "Pallet",
      status_detail: String(barcode.row.pallet_number ?? "").trim() || null,
      next_action: "continue_to_pallet",
      canonical_tracking: canon,
    };
  }

  if (barcode.kind === "package") {
    const pkgCode = String(barcode.row.package_code ?? "").trim();
    const slip = String(barcode.row.id_slip_contents ?? "").trim();
    const already =
      visual === "completed" ||
      (Number(barcode.row.actual_item_count ?? 0) >= Number(barcode.row.expected_item_count ?? 0) &&
        Number(barcode.row.expected_item_count ?? 0) > 0);
    return {
      match_status: already ? "already_scanned" : "found_package",
      entity_type: "package",
      entity_id: String(barcode.row.id ?? "").trim() || null,
      package_id: String(barcode.row.id ?? "").trim() || null,
      pallet_id: String(barcode.row.pallet_id ?? "").trim() || null,
      expected_package_id: firstInv?.expected_package_id ?? null,
      tracking_number: canon,
      slip_code: slip || null,
      package_code: pkgCode || null,
      status_label: already ? "Already scanned" : "Package",
      status_detail: pkgCode || slip || null,
      next_action: "continue_to_package",
      canonical_tracking: canon,
    };
  }

  if (barcode.kind === "slip") {
    return {
      match_status: visual === "completed" ? "already_scanned" : "found_slip",
      entity_type: "slip",
      entity_id: String(barcode.row.id ?? "").trim() || null,
      package_id: String(barcode.row.id ?? "").trim() || null,
      pallet_id: String(barcode.row.pallet_id ?? "").trim() || null,
      expected_package_id: firstInv?.expected_package_id ?? null,
      tracking_number: canon,
      slip_code: String(barcode.row.rma_number ?? barcode.row.id_slip_contents ?? "").trim() || normalized,
      package_code: String(barcode.row.package_code ?? "").trim() || null,
      status_label: "Slip",
      status_detail: String(barcode.row.rma_number ?? "").trim() || null,
      next_action: "continue_to_package",
      canonical_tracking: canon,
    };
  }

  if (barcode.kind === "tracking" || invRows.length > 0) {
    const field = invField ?? (barcode.kind === "tracking" ? "tracking_number" : null);
    const isSlip = field === "id_slip_contents";
    const expectedOnly = invRows.length > 0 && visual === "manual_new";
    const already = visual === "completed" || visual === "over_scanned";
    return {
      match_status: already
        ? "already_scanned"
        : expectedOnly
          ? "expected_only"
          : isSlip
            ? "found_slip"
            : "found_tracking",
      entity_type: expectedOnly ? "expected_package" : isSlip ? "slip" : "tracking",
      entity_id:
        (firstInv?.expected_package_id ||
          (barcode.kind !== "unknown" ? String(barcode.row.id ?? "").trim() : "")) ||
        null,
      package_id: null,
      pallet_id: null,
      expected_package_id: firstInv?.expected_package_id ?? null,
      tracking_number: canon,
      slip_code: isSlip ? normalized : firstInv?.id_slip_contents ?? null,
      package_code: null,
      status_label: statusLabelForVisual(visual),
      status_detail: null,
      next_action: visual === "manual_new" ? "create_orphan" : "continue_to_package",
      canonical_tracking: canon,
    };
  }

  return {
    match_status: "not_found",
    entity_type: "unknown",
    entity_id: null,
    package_id: null,
    pallet_id: null,
    expected_package_id: null,
    tracking_number: null,
    slip_code: null,
    package_code: null,
    status_label: "Not found",
    status_detail: "No tracking, slip, package, or pallet match for this store.",
    next_action: "show_not_found",
    canonical_tracking: null,
  };
}

/**
 * Canonical Shipment Entry gate lookup: inventory view + packages/pallets/expected_packages.
 * Never resolves product/SKU identifiers (no `products` / item tier).
 * @param opts.skipExpensiveFallback When true, skips the ILIKE/14k-row scan in fetchExpectedPackagesForTracking
 *   for likely tracking-format codes — caller must offer a "Deep search" action.
 */
export async function lookupShipmentEntryScanCode(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  rawCode: string,
  opts?: FetchExpectedPackagesOptions,
): Promise<ShipmentEntryLookupResult> {
  const lookupStartedAt = performance.now();
  let rpcMs = 0;
  let fallbackMs = 0;
  let fallbackReason: string | null = null;

  const gateFastNegative = Boolean(opts?.skipExpensiveFallback || opts?.gateFastNegative);
  const identityOpts: FetchExpectedPackagesOptions = {
    ...opts,
    skipExpensiveFallback: gateFastNegative,
    gateFastNegative,
  };

  const normalized_code = normalizeShipmentEntryScanCode(rawCode);
  const orgId = organizationId.trim();
  const sid = storeId.trim();

  const finishTiming = (result: ShipmentEntryLookupResult): ShipmentEntryLookupResult => ({
    ...result,
    gate_timing: {
      rpc_ms: Math.round(rpcMs),
      fallback_ms: Math.round(fallbackMs),
      total_ms: Math.round(performance.now() - lookupStartedAt),
      fallback_reason: fallbackReason,
    },
  });

  if (!normalized_code || !orgId || !sid) {
    return finishTiming({
      normalized_code,
      match_status: "not_found",
      entity_type: "unknown",
      entity_id: null,
      status_label: "Not found",
      status_detail: "Missing code or store scope.",
      next_action: "show_not_found",
      inventory_rows: [],
      inventory_matched_field: null,
      inventory_visual: "manual_new",
      barcode: { kind: "unknown", code: normalized_code },
      canonical_tracking: null,
    });
  }

  let inventory_rows: VInventoryStatusRow[] = [];
  let inventory_matched_field: InventoryViewMatchField | null = null;
  let identityScrubApplied = false;

  const rpcStartedAt = performance.now();
  const invResult = await fetchVInventoryStatusForScanCode(supabase, orgId, sid, normalized_code, identityOpts).catch(
    () => ({
      rows: [] as VInventoryStatusRow[],
      matchedField: null as InventoryViewMatchField | null,
      matchType: null as null,
      scrubApplied: false,
    }),
  );
  rpcMs = performance.now() - rpcStartedAt;

  inventory_rows = invResult.rows;
  inventory_matched_field = invResult.matchedField;
  identityScrubApplied = Boolean(invResult.scrubApplied);

  const identityMatchType = "matchType" in invResult ? invResult.matchType ?? null : null;
  if (
    identityMatchType === "product_identifier_fallback" ||
    inventory_matched_field === "fnsku" ||
    inventory_matched_field === "sku"
  ) {
    inventory_rows = [];
    inventory_matched_field = null;
  }

  let barcode: OperatorResolveResult;
  if (inventory_rows.length > 0 && inventory_matched_field) {
    if (inventory_matched_field === "tracking_number") {
      const first = inventory_rows[0]!;
      barcode = {
        kind: "tracking",
        row: {
          id: first.expected_package_id,
          tracking_number: first.tracking_number ?? normalized_code,
        } as Record<string, unknown>,
      };
    } else {
      barcode = { kind: "unknown", code: normalized_code };
    }
  } else if (identityMatchType) {
    barcode = { kind: "unknown", code: normalized_code };
  } else if (gateFastNegative && !shouldTryLimitedBarcodeProbe(normalized_code)) {
    barcode = { kind: "unknown", code: normalized_code };
    fallbackReason = "gate_fast_negative_rpc_miss";
  } else {
    const fbStartedAt = performance.now();
    if (gateFastNegative) {
      barcode = await resolveShipmentEntryBarcodeIndexedFast(supabase, orgId, sid, normalized_code);
      fallbackReason = "indexed_package_slip_probe";
    } else {
      barcode = await resolveShipmentEntryBarcode(supabase, orgId, sid, normalized_code, identityOpts);
      fallbackReason = "full_barcode_resolve";
    }
    fallbackMs += performance.now() - fbStartedAt;
  }

  if (!gateFastNegative && !inventory_rows.length && barcode.kind === "tracking") {
    const fbStartedAt = performance.now();
    const epRows = await fetchExpectedPackagesForTracking(supabase, orgId, sid, normalized_code, undefined, opts);
    fallbackMs += performance.now() - fbStartedAt;
    fallbackReason = "tracking_ep_fetch";
    if (epRows.length) {
      inventory_rows = epRows.map((r) => epRowToInventoryStatusRow(r as Record<string, unknown>, orgId, sid));
      inventory_matched_field = "tracking_number";
    }
  }

  if (!gateFastNegative && !inventory_rows.length && barcode.kind !== "unknown") {
    const tn = trackingFromBarcode(barcode);
    if (tn && tn !== normalized_code) {
      try {
        const fbStartedAt = performance.now();
        const inv2 = await fetchVInventoryStatusForScanCode(supabase, orgId, sid, tn, identityOpts);
        fallbackMs += performance.now() - fbStartedAt;
        fallbackReason = "tracking_relookup";
        if (inv2.rows.length) {
          inventory_rows = inv2.rows;
          inventory_matched_field = inv2.matchedField ?? "tracking_number";
        }
      } catch {
        /* keep package-only path */
      }
    }
  }

  if (
    !gateFastNegative &&
    !inventory_rows.length &&
    !identityMatchType &&
    !(opts?.skipExpensiveFallback && isLikelyShipmentTrackingCode(normalized_code))
  ) {
    const fbStartedAt = performance.now();
    const fb = await inventoryRowsFromExpectedPackagesFallback(supabase, orgId, sid, normalized_code);
    fallbackMs += performance.now() - fbStartedAt;
    fallbackReason = "ep_parent_fallback";
    if (fb.rows.length) {
      inventory_rows = fb.rows;
      inventory_matched_field = fb.matchedField;
    }
  }

  if (
    !gateFastNegative &&
    !inventory_rows.length &&
    !identityMatchType &&
    (barcode.kind === "package" || barcode.kind === "slip")
  ) {
    const row = barcode.row;
    inventory_rows = [
      {
        expected_package_id: "",
        organization_id: orgId,
        store_id: sid,
        tracking_number: String(row.tracking_number ?? "").trim() || null,
        id_slip_contents: String(row.id_slip_contents ?? "").trim() || null,
        sku: null,
        fnsku: null,
        asin: null,
        order_id: null,
        status: null,
        product_name: null,
        product_display_name: null,
        product_id: null,
        resolved_product_id: null,
        resolved_catalog_product_id: null,
        product_linkage_status: null,
        identifier_resolution_status: null,
        identifier_resolution_confidence: null,
        carrier: null,
        total_expected: Number(row.expected_item_count ?? 0) || 0,
        total_scanned: Number(row.actual_item_count ?? 0) || 0,
      },
    ];
    inventory_matched_field =
      barcode.kind === "slip" ? "id_slip_contents" : ("tracking_number" as InventoryViewMatchField);
  }

  try {
    if (!identityScrubApplied) {
      inventory_rows = await scrubInventoryRowsExcludingVoidedPackages(
        supabase,
        orgId,
        sid,
        inventory_rows,
        inventory_matched_field,
        normalized_code,
      );
    }
  } catch {
    /* keep pre-scrub rows on failure */
  }

  const agg = aggregateInventoryStatus(inventory_rows);
  let inventory_visual = resolveInventoryGateVisualStatus(inventory_rows, agg);
  if (inventory_rows.length === 0 && barcode.kind !== "unknown") {
    const fromBarcode = visualFromBarcodeRow(barcode);
    if (fromBarcode && fromBarcode !== "manual_new") inventory_visual = fromBarcode;
  }
  const meta = deriveMatchMetadata(barcode, inventory_rows, inventory_matched_field, inventory_visual, normalized_code);

  return finishTiming({
    normalized_code,
    ...meta,
    inventory_rows,
    inventory_matched_field,
    inventory_visual,
    barcode,
    identity_match_type: identityMatchType,
  });
}

/** Demo / offline lookup — mirrors production order without Supabase. */
export function mockLookupShipmentEntryScanCode(rawCode: string): ShipmentEntryLookupResult {
  const normalized_code = normalizeShipmentEntryScanCode(rawCode);
  if (!normalized_code || /^NEW-/i.test(normalized_code) || normalized_code.length < 3) {
    const emptyAgg = aggregateInventoryStatus([]);
    return {
      normalized_code,
      match_status: "not_found",
      entity_type: "unknown",
      entity_id: null,
      status_label: "New",
      next_action: "create_orphan",
      inventory_rows: [],
      inventory_matched_field: null,
      inventory_visual: "manual_new",
      barcode: { kind: "unknown", code: normalized_code },
      canonical_tracking: normalized_code,
    };
  }

  let barcode: OperatorResolveResult = { kind: "unknown", code: normalized_code };
  for (const only of SHIPMENT_ENTRY_RESOLVE_ORDER) {
    const r = mockResolveOperatorBarcode(normalized_code, only);
    if (r.kind !== "unknown") {
      barcode = r;
      break;
    }
  }

  const inv = mockVInventoryRowsForScanCode(normalized_code);
  let inventory_rows = inv.rows;
  let inventory_matched_field = inv.matchedField;

  if (!inventory_rows.length && barcode.kind !== "unknown") {
    const tn = trackingFromBarcode(barcode);
    if (tn) {
      const inv2 = mockVInventoryRowsForScanCode(tn);
      inventory_rows = inv2.rows;
      inventory_matched_field = inv2.matchedField ?? "tracking_number";
    }
  }

  if (!inventory_rows.length) {
    const base = mockExpectedPackageDetailRows();
    const exactEp = base.filter((r) => trackingKeysEqual(String(r.tracking_number ?? ""), normalized_code));
    if (exactEp.length) {
      inventory_rows = exactEp.map((r) =>
        epRowToInventoryStatusRow(r as Record<string, unknown>, "", ""),
      );
      inventory_matched_field = "tracking_number";
    }
  }

  const agg = aggregateInventoryStatus(inventory_rows);
  const inventory_visual = resolveInventoryGateVisualStatus(inventory_rows, agg);
  const meta = deriveMatchMetadata(barcode, inventory_rows, inventory_matched_field, inventory_visual, normalized_code);

  return {
    normalized_code,
    ...meta,
    inventory_rows,
    inventory_matched_field,
    inventory_visual,
    barcode,
  };
}
