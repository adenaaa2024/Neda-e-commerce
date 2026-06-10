/**
 * Phase 6F-B — read-only slip vs shipment expected vs operator scan validation preview.
 * No writes, no claim creation, no manifest mutation.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { returnItemNotesMarkOffSlip } from "@/lib/scanner/item-scan-off-slip";
import {
  expectedPackageRowToProductGrain,
  productGrainKey,
  returnItemRowToProductGrain,
  slipRowToProductGrain,
  type ProductGrain,
} from "@/lib/scanner/product-grain-match";
import { parseOperatorItemScanFromManifestData } from "@/lib/scanner/package-operator-item-scan";
import { missingReviewRecordedQtyForSlip } from "@/lib/scanner/package-missing-review-manifest";
import {
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
} from "@/lib/scanner/operator-slip-item-resolve";
import { computeSlipLineExpectedVsReceived } from "@/lib/scanner/slip-contents-missing-expected";
import { shouldExcludeReturnItemFromScannerCounts } from "@/lib/scanner/return-items-test-data-guard";
import type { ReviewGrainRollupInput } from "@/lib/scanner/review-engine/review-engine-types";
import {
  buildBoxScopeReview,
  unifiedReviewToSlipShipmentPreview,
} from "@/lib/scanner/review-engine";
import type { SlipShipmentValidationPreview } from "@/lib/scanner/slip-shipment-validation-types";
import { isUuidString } from "@/lib/uuid";

type SlipAgg = {
  qty: number;
  slip_content_ids: string[];
  grain: ProductGrain;
  label: string | null;
};

type EpAgg = {
  qty: number;
  expected_package_ids: string[];
  build_sources: string[];
  grain: ProductGrain;
  label: string | null;
};

type ScanAgg = {
  qty: number;
  off_manifest_qty: number;
  return_item_ids: string[];
  grain: ProductGrain;
  matched_slip_content_id: string | null;
};

function floorQty(v: unknown): number {
  const n = Math.floor(Number(v ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function unitQty(row: Record<string, unknown>): number {
  return Math.max(1, floorQty(row.scanned_quantity ?? row.quantity ?? 1));
}

function lineLabel(grain: ProductGrain): string | null {
  return (
    grain.fnsku ??
    grain.sku ??
    grain.asin ??
    grain.upc ??
    grain.gtin ??
    (grain.title ? grain.title.slice(0, 80) : null)
  );
}

function slipRowsToMatchRows(lines: Record<string, unknown>[]): SlipBarcodeMatchRow[] {
  return lines.map((row, idx) => ({
    id: String(row.id ?? "").trim() || null,
    upc: typeof row.upc === "string" ? row.upc : null,
    fnsku: typeof row.fnsku === "string" ? row.fnsku : null,
    description: typeof row.description === "string" ? row.description : null,
    quantity: floorQty(row.quantity),
    sort_index: idx,
  }));
}

function returnItemNotes(row: Record<string, unknown>): string | null {
  return typeof row.notes === "string" ? row.notes : null;
}

function scannedBarcodeFromReturnItem(row: Record<string, unknown>): string {
  const f = String(row.fnsku ?? "").trim();
  if (f) return f;
  const s = String(row.sku ?? "").trim();
  if (s) return s;
  return String(row.product_identifier ?? "").trim();
}

function slipIdForScan(
  row: Record<string, unknown>,
  slipMatchRows: SlipBarcodeMatchRow[],
): string | null {
  if (returnItemNotesMarkOffSlip(returnItemNotes(row))) return null;
  const barcode = scannedBarcodeFromReturnItem(row);
  if (!barcode) return null;
  const outcome = resolveItemBarcodeAgainstSlipRows(barcode, slipMatchRows);
  if (outcome.kind !== "single") return null;
  const sid = String(outcome.slip.id ?? "").trim();
  return sid && isUuidString(sid) ? sid : null;
}

export async function buildSlipShipmentValidationPreview(
  supabase: SupabaseClient,
  organizationId: string,
  packageId: string,
): Promise<SlipShipmentValidationPreview | { error: string }> {
  const orgId = String(organizationId ?? "").trim();
  const pkgId = String(packageId ?? "").trim();
  if (!isUuidString(orgId) || !isUuidString(pkgId)) {
    return { error: "Invalid organization or package id." };
  }

  const { data: pkg, error: pkgErr } = await supabase
    .from("packages")
    .select(
      "id, organization_id, store_id, tracking_number, id_slip_contents, package_code, manifest_data, deleted_at",
    )
    .eq("id", pkgId)
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgErr) return { error: pkgErr.message };
  if (!pkg) return { error: "Package not found." };

  const pkgRow = pkg as Record<string, unknown>;
  const storeId = String(pkgRow.store_id ?? "").trim() || null;
  const tracking = String(pkgRow.tracking_number ?? "").trim() || null;
  const manifestData = pkgRow.manifest_data;
  const operatorScan = parseOperatorItemScanFromManifestData(manifestData);
  const receiveFinalized = operatorScan.receive_state === "finalized";

  const slipSelectAttempts = [
    "id, quantity, fnsku, upc, parsed_asin, parsed_sku, parsed_upc, parsed_fnsku, description, resolved_product_id, notes",
    "id, quantity, fnsku, upc, description, resolved_product_id, notes",
    "id, quantity, fnsku, upc, description",
  ];
  let slipLines: Record<string, unknown>[] = [];
  for (const sel of slipSelectAttempts) {
    const { data, error } = await supabase
      .from("slip_contents")
      .select(sel)
      .eq("package_id", pkgId)
      .order("sort_index", { ascending: true });
    if (!error) {
      slipLines = (data ?? []) as unknown as Record<string, unknown>[];
      break;
    }
    if (!String(error.message).toLowerCase().includes("column")) return { error: error.message };
  }

  const riSelectAttempts = [
    "id, fnsku, sku, asin, product_identifier, item_name, notes, scanned_quantity, quantity, resolved_product_id",
    "id, fnsku, sku, product_identifier, item_name, notes, scanned_quantity, quantity, resolved_product_id",
    "id, fnsku, sku, product_identifier, notes, scanned_quantity",
  ];
  let returnItems: Record<string, unknown>[] = [];
  for (const sel of riSelectAttempts) {
    const { data, error } = await supabase
      .from("return_items")
      .select(sel)
      .eq("package_id", pkgId)
      .eq("organization_id", orgId)
      .is("deleted_at", null);
    if (!error) {
      returnItems = (data ?? []) as unknown as Record<string, unknown>[];
      break;
    }
    if (!String(error.message).toLowerCase().includes("column")) return { error: error.message };
  }

  let epLines: Record<string, unknown>[] = [];
  if (tracking && storeId && isUuidString(storeId)) {
    const epSelectAttempts = [
      "id, fnsku, sku, asin, expected_scan_quantity, build_source, resolved_product_id, disposition",
      "id, fnsku, sku, asin, expected_scan_quantity, build_source, resolved_product_id",
      "id, fnsku, sku, expected_scan_quantity, build_source, resolved_product_id, disposition",
      "id, fnsku, sku, expected_scan_quantity, build_source, resolved_product_id",
    ];
    for (const sel of epSelectAttempts) {
      const { data, error } = await supabase
        .from("expected_packages")
        .select(sel)
        .eq("organization_id", orgId)
        .eq("store_id", storeId)
        .eq("tracking_number", tracking);
      if (!error) {
        epLines = (data ?? []) as unknown as Record<string, unknown>[];
        break;
      }
      if (!String(error.message).toLowerCase().includes("column")) break;
    }
  }

  const slipByKey = new Map<string, SlipAgg>();
  const slipIdToKey = new Map<string, string>();
  for (const row of slipLines) {
    const grain = slipRowToProductGrain(row);
    const key = productGrainKey(grain) ?? `slip:${String(row.id ?? "")}`;
    const qty = floorQty(row.quantity);
    const slipId = String(row.id ?? "").trim();
    if (slipId && isUuidString(slipId)) slipIdToKey.set(slipId, key);
    const prev = slipByKey.get(key);
    if (prev) {
      prev.qty += qty;
      if (slipId && isUuidString(slipId)) prev.slip_content_ids.push(slipId);
    } else {
      slipByKey.set(key, {
        qty,
        slip_content_ids: slipId && isUuidString(slipId) ? [slipId] : [],
        grain,
        label: lineLabel(grain),
      });
    }
  }

  const epByKey = new Map<string, EpAgg>();
  for (const row of epLines) {
    const grain = expectedPackageRowToProductGrain(row);
    const key = productGrainKey(grain) ?? `ep:${String(row.id ?? "")}`;
    const qty = floorQty(row.expected_scan_quantity);
    const epId = String(row.id ?? "").trim();
    const buildSource = String(row.build_source ?? "").trim() || null;
    const prev = epByKey.get(key);
    if (prev) {
      prev.qty += qty;
      if (epId && isUuidString(epId)) prev.expected_package_ids.push(epId);
      if (buildSource && !prev.build_sources.includes(buildSource)) prev.build_sources.push(buildSource);
    } else {
      epByKey.set(key, {
        qty,
        expected_package_ids: epId && isUuidString(epId) ? [epId] : [],
        build_sources: buildSource ? [buildSource] : [],
        grain,
        label: lineLabel(grain),
      });
    }
  }

  const slipMatchRows = slipRowsToMatchRows(slipLines);
  const scanByKey = new Map<string, ScanAgg>();
  for (const row of returnItems) {
    if (
      shouldExcludeReturnItemFromScannerCounts({
        item_name: typeof row.item_name === "string" ? row.item_name : null,
        sku: typeof row.sku === "string" ? row.sku : null,
        fnsku: typeof row.fnsku === "string" ? row.fnsku : null,
        product_identifier: typeof row.product_identifier === "string" ? row.product_identifier : null,
        notes: returnItemNotes(row),
      })
    ) {
      continue;
    }
    const grain = returnItemRowToProductGrain(row);
    const offManifest = returnItemNotesMarkOffSlip(returnItemNotes(row));
    const matchedSlipId = slipIdForScan(row, slipMatchRows);
    const keyFromSlip = matchedSlipId ? slipIdToKey.get(matchedSlipId) : null;
    const key = keyFromSlip ?? productGrainKey(grain) ?? `scan:${String(row.id ?? "")}`;
    const qty = unitQty(row);
    const riId = String(row.id ?? "").trim();
    const prev = scanByKey.get(key);
    if (prev) {
      prev.qty += qty;
      if (offManifest) prev.off_manifest_qty += qty;
      if (riId && isUuidString(riId)) prev.return_item_ids.push(riId);
      if (!prev.matched_slip_content_id && matchedSlipId) prev.matched_slip_content_id = matchedSlipId;
    } else {
      scanByKey.set(key, {
        qty,
        off_manifest_qty: offManifest ? qty : 0,
        return_item_ids: riId && isUuidString(riId) ? [riId] : [],
        grain,
        matched_slip_content_id: matchedSlipId,
      });
    }
  }

  const allKeys = new Set([...slipByKey.keys(), ...epByKey.keys(), ...scanByKey.keys()]);
  const grains: ReviewGrainRollupInput[] = [];

  for (const key of allKeys) {
    const slip = slipByKey.get(key);
    const ep = epByKey.get(key);
    const scan = scanByKey.get(key);
    const slipQty = slip?.qty ?? 0;
    const epQty = ep?.qty ?? 0;
    const scannedQty = scan?.qty ?? 0;
    const offManifestQty = scan?.off_manifest_qty ?? 0;
    const grain = slip?.grain ?? ep?.grain ?? scan?.grain ?? {
      resolved_product_id: null,
      fnsku: null,
      asin: null,
      sku: null,
      upc: null,
      gtin: null,
      title: null,
    };

    let recordedMissingQty = 0;
    for (const slipId of slip?.slip_content_ids ?? []) {
      const manifestRecorded = missingReviewRecordedQtyForSlip(manifestData, slipId);
      const slipRow = slipLines.find((r) => String(r.id ?? "") === slipId);
      const expectedForSlip = floorQty(slipRow?.quantity);
      const receivedForSlip =
        scan?.matched_slip_content_id === slipId
          ? scannedQty
          : slip?.slip_content_ids.length === 1
            ? scannedQty
            : 0;
      const qtyLine = computeSlipLineExpectedVsReceived({
        expectedQty: expectedForSlip,
        receivedQty: receivedForSlip,
        manifestRecordedMissingQty: manifestRecorded,
        notes: slipRow?.notes,
      });
      recordedMissingQty += qtyLine.recordedMissing;
    }

    const expectedCap = Math.max(slipQty, epQty);
    const qtyLine = computeSlipLineExpectedVsReceived({
      expectedQty: expectedCap,
      receivedQty: scannedQty,
      manifestRecordedMissingQty: recordedMissingQty > 0 ? recordedMissingQty : undefined,
    });

    grains.push({
      grain_key: key,
      grain,
      label: slip?.label ?? ep?.label ?? lineLabel(grain),
      slip_qty: slipQty,
      shipment_expected_qty: epQty,
      received_qty: scannedQty,
      off_manifest_qty: offManifestQty,
      marked_missing_qty: qtyLine.recordedMissing,
      remaining_missing_qty: qtyLine.remainingMissing,
      slip_content_ids: slip?.slip_content_ids ?? [],
      expected_package_ids: ep?.expected_package_ids ?? [],
      return_item_ids: scan?.return_item_ids ?? [],
      package_ids: [pkgId],
      build_sources: ep?.build_sources ?? [],
      has_slip: Boolean(slip),
      has_shipment: Boolean(ep),
      receive_finalized: receiveFinalized,
    });
  }

  const unified = buildBoxScopeReview({
    organization_id: orgId,
    store_id: storeId,
    package_ids: [pkgId],
    pallet_id: null,
    tracking_numbers: tracking ? [tracking] : [],
    grains,
  });

  return unifiedReviewToSlipShipmentPreview(unified, {
    package_id: pkgId,
    package_code: String(pkgRow.package_code ?? "").trim() || null,
    slip_code: String(pkgRow.id_slip_contents ?? "").trim() || null,
    tracking_number: tracking,
    receive_state: operatorScan.receive_state,
  });
}
