/**
 * Phase 6E-A — read-only pallet/shipment review preview.
 * Aggregates shipment expected, slip evidence, and physical scans before close.
 * No writes, no claim creation, no pallet/shipment close.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { returnItemNotesMarkOffSlip } from "@/lib/scanner/item-scan-off-slip";
import { parseOperatorItemScanFromManifestData } from "@/lib/scanner/package-operator-item-scan";
import { missingReviewRecordedQtyForSlip } from "@/lib/scanner/package-missing-review-manifest";
import {
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
} from "@/lib/scanner/operator-slip-item-resolve";
import {
  expectedPackageRowToProductGrain,
  productGrainConfidence,
  productGrainKey,
  returnItemRowToProductGrain,
  slipRowToProductGrain,
  type ProductGrain,
} from "@/lib/scanner/product-grain-match";
import type {
  PalletShipmentReviewBucket,
  PalletShipmentReviewClaimMeaning,
  PalletShipmentReviewLine,
  PalletShipmentReviewPackageRef,
  PalletShipmentReviewPreview,
  PalletShipmentReviewScopeInput,
  PalletShipmentReviewScopeKind,
  PalletShipmentReviewSuggestedAction,
} from "@/lib/scanner/pallet-shipment-review-types";
import { fetchDistinctTrackingNumbersForPallet } from "@/lib/scanner/operator-tracking-expectations";
import { shouldExcludeReturnItemFromScannerCounts } from "@/lib/scanner/return-items-test-data-guard";
import { isUuidString } from "@/lib/uuid";

type ScopePackage = {
  id: string;
  package_code: string | null;
  id_slip_contents: string | null;
  tracking_number: string | null;
  manifest_data: unknown;
  outside_photo_urls: unknown;
  inside_photo_urls: unknown;
  slip_photo_urls: unknown;
};

type SlipAgg = {
  qty: number;
  slip_content_ids: string[];
  package_ids: Set<string>;
  grain: ProductGrain;
  label: string | null;
};

type EpAgg = {
  qty: number;
  expected_package_ids: string[];
  grain: ProductGrain;
  label: string | null;
};

type ScanAgg = {
  qty: number;
  off_manifest_qty: number;
  problem_qty: number;
  return_item_ids: string[];
  package_ids: Set<string>;
  grain: ProductGrain;
  photo_count: number;
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

function photoUrlCount(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.filter((u) => String(u ?? "").trim().length > 0).length;
}

function packagePhotoCount(pkg: ScopePackage): number {
  return (
    photoUrlCount(pkg.outside_photo_urls) +
    photoUrlCount(pkg.inside_photo_urls) +
    photoUrlCount(pkg.slip_photo_urls)
  );
}

function returnItemPhotoCount(row: Record<string, unknown>): number {
  const pe = row.photo_evidence;
  if (pe && typeof pe === "object" && !Array.isArray(pe)) {
    let total = 0;
    for (const v of Object.values(pe as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        total += Math.max(0, Math.floor(v));
      }
    }
    return total;
  }
  return 0;
}

function isProblemReturnItem(row: Record<string, unknown>): boolean {
  const cond = row.conditions;
  if (!Array.isArray(cond)) return false;
  const tags = cond.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0) return false;
  if (tags.length === 1 && tags[0] === "sellable") return false;
  return true;
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
  if (returnItemNotesMarkOffSlip(typeof row.notes === "string" ? row.notes : null)) return null;
  const barcode = scannedBarcodeFromReturnItem(row);
  if (!barcode) return null;
  const outcome = resolveItemBarcodeAgainstSlipRows(barcode, slipMatchRows);
  if (outcome.kind !== "single") return null;
  const sid = String(outcome.slip.id ?? "").trim();
  return sid && isUuidString(sid) ? sid : null;
}

function isAmazonShipmentExpectedRow(row: Record<string, unknown>): boolean {
  const buildSource = String(row.build_source ?? "").trim().toLowerCase();
  if (buildSource === "receive_allocated") return false;
  const parent = String(row.parent_expected_package_id ?? "").trim();
  if (parent && isUuidString(parent)) return false;
  return true;
}

function emptyBucketCounts(): Record<PalletShipmentReviewBucket, number> {
  return {
    expected_received_complete: 0,
    expected_under_received: 0,
    expected_over_received: 0,
    scanned_off_manifest: 0,
    slip_only_evidence: 0,
    shipment_only_expected: 0,
    damaged_or_problem_items: 0,
    pending_review: 0,
  };
}

function classifyReviewBucket(input: {
  expectedQty: number;
  slipQty: number;
  scannedQty: number;
  offManifestQty: number;
  problemQty: number;
  operatorNoteMissingQty: number;
  confidence: ReturnType<typeof productGrainConfidence>;
  hasSlip: boolean;
  hasEp: boolean;
}): PalletShipmentReviewBucket {
  if (input.problemQty > 0) return "damaged_or_problem_items";

  const hasExpectation = input.hasSlip || input.hasEp;

  if (input.offManifestQty > 0 && input.expectedQty === 0 && input.slipQty === 0) {
    return "scanned_off_manifest";
  }

  if (input.hasSlip && !input.hasEp && input.slipQty > 0) {
    if (input.offManifestQty > 0 && input.scannedQty > input.slipQty) return "expected_over_received";
    return "slip_only_evidence";
  }

  if (input.hasEp && !input.hasSlip && input.expectedQty > 0) {
    if (input.scannedQty > input.expectedQty) return "expected_over_received";
    if (input.scannedQty < input.expectedQty) return "expected_under_received";
    if (input.scannedQty === input.expectedQty) return "expected_received_complete";
    return "shipment_only_expected";
  }

  if (input.expectedQty > 0) {
    if (input.scannedQty > input.expectedQty) return "expected_over_received";
    if (input.scannedQty < input.expectedQty) return "expected_under_received";
    return "expected_received_complete";
  }

  if (input.offManifestQty > 0 || (input.scannedQty > 0 && !hasExpectation)) {
    return "scanned_off_manifest";
  }

  if (
    input.confidence === "unresolved" ||
    input.confidence === "title_low" ||
    input.operatorNoteMissingQty > 0
  ) {
    return "pending_review";
  }

  return "pending_review";
}

function suggestedActionForBucket(bucket: PalletShipmentReviewBucket): PalletShipmentReviewSuggestedAction {
  switch (bucket) {
    case "expected_received_complete":
      return "none";
    case "expected_under_received":
      return "confirm_shortage_at_close";
    case "expected_over_received":
      return "review_excess_scans";
    case "scanned_off_manifest":
      return "verify_off_manifest_identity";
    case "slip_only_evidence":
      return "slip_evidence_triage";
    case "shipment_only_expected":
      return "check_other_boxes_on_shipment";
    case "damaged_or_problem_items":
      return "review_damage_evidence";
    case "pending_review":
      return "resolve_linkage_or_notes";
    default:
      return "resolve_linkage_or_notes";
  }
}

function claimMeaningForBucket(bucket: PalletShipmentReviewBucket): PalletShipmentReviewClaimMeaning {
  switch (bucket) {
    case "expected_received_complete":
      return "no_claim_delta";
    case "expected_under_received":
      return "potential_shortage_claim_at_close";
    case "expected_over_received":
      return "no_excess_claim";
    case "scanned_off_manifest":
      return "physical_only_no_auto_claim";
    case "slip_only_evidence":
      return "excluded_from_claim_pool";
    case "shipment_only_expected":
      return "included_in_expected_pool";
    case "damaged_or_problem_items":
      return "damage_claim_candidate";
    case "pending_review":
      return "no_claim_until_review";
    default:
      return "no_claim_until_review";
  }
}

function packageRefFromRow(row: ScopePackage): PalletShipmentReviewPackageRef {
  const scan = parseOperatorItemScanFromManifestData(row.manifest_data);
  return {
    package_id: row.id,
    package_code: row.package_code,
    id_slip_contents: row.id_slip_contents,
    tracking_number: row.tracking_number,
    receive_state: scan.receive_state,
  };
}

async function loadScopePackages(
  supabase: SupabaseClient,
  orgId: string,
  input: PalletShipmentReviewScopeInput,
): Promise<
  | { ok: true; packages: ScopePackage[]; scopeKind: PalletShipmentReviewScopeKind; trackingNumbers: string[] }
  | { ok: false; error: string }
> {
  const palletId = String(input.palletId ?? "").trim();
  const trackingInput = String(input.trackingNumber ?? "").trim();

  const select =
    "id, package_code, id_slip_contents, tracking_number, manifest_data, outside_photo_urls, inside_photo_urls, slip_photo_urls, store_id";

  if (palletId && isUuidString(palletId)) {
    const { data, error } = await supabase
      .from("packages")
      .select(select)
      .eq("organization_id", orgId)
      .eq("pallet_id", palletId)
      .is("deleted_at", null);
    if (error) return { ok: false, error: error.message };
    const packages = (data ?? []) as unknown as ScopePackage[];
    const trackingNumbers = await fetchDistinctTrackingNumbersForPallet(supabase, orgId, palletId);
    return { ok: true, packages, scopeKind: "pallet", trackingNumbers };
  }

  if (trackingInput) {
    let q = supabase
      .from("packages")
      .select(select)
      .eq("organization_id", orgId)
      .eq("tracking_number", trackingInput)
      .is("deleted_at", null);
    if (isUuidString(input.storeId)) {
      q = q.eq("store_id", input.storeId);
    }
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    const packages = (data ?? []) as unknown as ScopePackage[];
    return { ok: true, packages, scopeKind: "shipment_tracking", trackingNumbers: [trackingInput] };
  }

  return { ok: false, error: "Provide palletId or trackingNumber." };
}

export async function buildPalletShipmentReviewPreview(
  supabase: SupabaseClient,
  input: PalletShipmentReviewScopeInput,
): Promise<PalletShipmentReviewPreview | { error: string }> {
  const orgId = String(input.organizationId ?? "").trim();
  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(orgId) || !isUuidString(storeId)) {
    return { error: "Invalid organization or store id." };
  }

  const scopeLoad = await loadScopePackages(supabase, orgId, input);
  if (!scopeLoad.ok) return { error: scopeLoad.error };

  const { packages, scopeKind, trackingNumbers } = scopeLoad;
  const pkgIds = packages.map((p) => p.id);
  const pkgById = new Map(packages.map((p) => [p.id, p]));

  const slipSelectAttempts = [
    "id, package_id, quantity, fnsku, upc, parsed_asin, parsed_sku, parsed_upc, parsed_fnsku, description, resolved_product_id, notes",
    "id, package_id, quantity, fnsku, upc, description, resolved_product_id, notes",
    "id, package_id, quantity, fnsku, upc, description",
  ];
  let slipLines: Record<string, unknown>[] = [];
  if (pkgIds.length > 0) {
    for (const sel of slipSelectAttempts) {
      const { data, error } = await supabase
        .from("slip_contents")
        .select(sel)
        .in("package_id", pkgIds)
        .order("sort_index", { ascending: true });
      if (!error) {
        slipLines = (data ?? []) as unknown as Record<string, unknown>[];
        break;
      }
      if (!String(error.message).toLowerCase().includes("column")) return { error: error.message };
    }
  }

  const riSelectAttempts = [
    "id, package_id, fnsku, sku, asin, product_identifier, item_name, notes, scanned_quantity, quantity, resolved_product_id, conditions, photo_evidence",
    "id, package_id, fnsku, sku, product_identifier, item_name, notes, scanned_quantity, quantity, resolved_product_id, conditions",
    "id, package_id, fnsku, sku, product_identifier, notes, scanned_quantity, quantity, resolved_product_id",
  ];
  let returnItems: Record<string, unknown>[] = [];
  if (pkgIds.length > 0) {
    for (const sel of riSelectAttempts) {
      const { data, error } = await supabase
        .from("return_items")
        .select(sel)
        .in("package_id", pkgIds)
        .eq("organization_id", orgId)
        .is("deleted_at", null);
      if (!error) {
        returnItems = (data ?? []) as unknown as Record<string, unknown>[];
        break;
      }
      if (!String(error.message).toLowerCase().includes("column")) return { error: error.message };
    }
  }

  let epLines: Record<string, unknown>[] = [];
  const trackings = trackingNumbers.length
    ? trackingNumbers
    : [...new Set(packages.map((p) => p.tracking_number).filter(Boolean))] as string[];
  if (trackings.length > 0) {
    const epSelectAttempts = [
      "id, fnsku, sku, asin, expected_scan_quantity, build_source, resolved_product_id, disposition, parent_expected_package_id, tracking_number",
      "id, fnsku, sku, asin, expected_scan_quantity, build_source, resolved_product_id, parent_expected_package_id, tracking_number",
      "id, fnsku, sku, expected_scan_quantity, build_source, resolved_product_id, tracking_number",
    ];
    for (const tn of trackings) {
      for (const sel of epSelectAttempts) {
        const { data, error } = await supabase
          .from("expected_packages")
          .select(sel)
          .eq("organization_id", orgId)
          .eq("store_id", storeId)
          .eq("tracking_number", tn);
        if (!error) {
          epLines.push(...((data ?? []) as unknown as Record<string, unknown>[]));
          break;
        }
        if (!String(error.message).toLowerCase().includes("column")) break;
      }
    }
  }
  epLines = epLines.filter(isAmazonShipmentExpectedRow);

  const slipByKey = new Map<string, SlipAgg>();
  const slipIdToKey = new Map<string, string>();
  const slipIdToPackageId = new Map<string, string>();
  for (const row of slipLines) {
    const grain = slipRowToProductGrain(row);
    const key = productGrainKey(grain) ?? `slip:${String(row.id ?? "")}`;
    const qty = floorQty(row.quantity);
    const slipId = String(row.id ?? "").trim();
    const pkgId = String(row.package_id ?? "").trim();
    if (slipId && isUuidString(slipId)) {
      slipIdToKey.set(slipId, key);
      if (pkgId) slipIdToPackageId.set(slipId, pkgId);
    }
    const prev = slipByKey.get(key);
    if (prev) {
      prev.qty += qty;
      if (slipId && isUuidString(slipId)) prev.slip_content_ids.push(slipId);
      if (pkgId) prev.package_ids.add(pkgId);
    } else {
      slipByKey.set(key, {
        qty,
        slip_content_ids: slipId && isUuidString(slipId) ? [slipId] : [],
        package_ids: pkgId ? new Set([pkgId]) : new Set(),
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
    const prev = epByKey.get(key);
    if (prev) {
      prev.qty += qty;
      if (epId && isUuidString(epId)) prev.expected_package_ids.push(epId);
    } else {
      epByKey.set(key, {
        qty,
        expected_package_ids: epId && isUuidString(epId) ? [epId] : [],
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
        notes: typeof row.notes === "string" ? row.notes : null,
      })
    ) {
      continue;
    }
    const grain = returnItemRowToProductGrain(row);
    const notes = typeof row.notes === "string" ? row.notes : null;
    const offManifest = returnItemNotesMarkOffSlip(notes);
    const matchedSlipId = slipIdForScan(row, slipMatchRows);
    const keyFromSlip = matchedSlipId ? slipIdToKey.get(matchedSlipId) : null;
    const key = keyFromSlip ?? productGrainKey(grain) ?? `scan:${String(row.id ?? "")}`;
    const qty = unitQty(row);
    const problem = isProblemReturnItem(row);
    const riId = String(row.id ?? "").trim();
    const pkgId = String(row.package_id ?? "").trim();
    const prev = scanByKey.get(key);
    if (prev) {
      prev.qty += qty;
      if (offManifest) prev.off_manifest_qty += qty;
      if (problem) prev.problem_qty += qty;
      if (riId && isUuidString(riId)) prev.return_item_ids.push(riId);
      if (pkgId) prev.package_ids.add(pkgId);
      prev.photo_count += returnItemPhotoCount(row);
    } else {
      scanByKey.set(key, {
        qty,
        off_manifest_qty: offManifest ? qty : 0,
        problem_qty: problem ? qty : 0,
        return_item_ids: riId && isUuidString(riId) ? [riId] : [],
        package_ids: pkgId ? new Set([pkgId]) : new Set(),
        grain,
        photo_count: returnItemPhotoCount(row),
      });
    }
  }

  const operatorNoteMissingByKey = new Map<string, number>();
  for (const pkg of packages) {
    for (const row of slipLines) {
      const slipId = String(row.id ?? "").trim();
      const pkgId = String(row.package_id ?? "").trim();
      if (pkgId !== pkg.id || !slipId) continue;
      const key = slipIdToKey.get(slipId);
      if (!key) continue;
      const recorded = missingReviewRecordedQtyForSlip(pkg.manifest_data, slipId);
      if (recorded != null && recorded > 0) {
        operatorNoteMissingByKey.set(key, (operatorNoteMissingByKey.get(key) ?? 0) + recorded);
      }
    }
  }

  const allKeys = new Set([...slipByKey.keys(), ...epByKey.keys(), ...scanByKey.keys()]);
  const lines: PalletShipmentReviewLine[] = [];

  for (const key of allKeys) {
    const slip = slipByKey.get(key);
    const ep = epByKey.get(key);
    const scan = scanByKey.get(key);
    const expectedQty = ep?.qty ?? 0;
    const slipQty = slip?.qty ?? 0;
    const scannedQty = scan?.qty ?? 0;
    const offManifestQty = scan?.off_manifest_qty ?? 0;
    const problemQty = scan?.problem_qty ?? 0;
    const operatorNoteMissingQty = operatorNoteMissingByKey.get(key) ?? 0;
    const grain = slip?.grain ?? ep?.grain ?? scan?.grain ?? {
      resolved_product_id: null,
      fnsku: null,
      asin: null,
      sku: null,
      upc: null,
      gtin: null,
      title: null,
    };
    const confidence = productGrainConfidence(grain);

    const bucket = classifyReviewBucket({
      expectedQty,
      slipQty,
      scannedQty,
      offManifestQty,
      problemQty,
      operatorNoteMissingQty,
      confidence,
      hasSlip: Boolean(slip),
      hasEp: Boolean(ep),
    });

    const packageIdSet = new Set<string>([
      ...(slip?.package_ids ?? []),
      ...(scan?.package_ids ?? []),
    ]);
    const packageRefs: PalletShipmentReviewPackageRef[] = [...packageIdSet]
      .map((id) => pkgById.get(id))
      .filter(Boolean)
      .map((p) => packageRefFromRow(p!));

    let evidencePhotoCount = scan?.photo_count ?? 0;
    for (const id of packageIdSet) {
      const pkg = pkgById.get(id);
      if (pkg) evidencePhotoCount += packagePhotoCount(pkg);
    }

    lines.push({
      grain_key: key,
      bucket,
      grain,
      confidence,
      resolved_product_id: grain.resolved_product_id,
      identifiers: {
        upc: grain.upc ?? grain.gtin,
        sku: grain.sku,
        fnsku: grain.fnsku,
        asin: grain.asin,
      },
      expected_qty: expectedQty,
      slip_qty: slipQty,
      scanned_qty: scannedQty,
      delta_qty: scannedQty - expectedQty,
      off_manifest_scanned_qty: offManifestQty,
      operator_note_missing_qty: operatorNoteMissingQty,
      problem_item_qty: problemQty,
      packages: packageRefs,
      evidence_photo_count: evidencePhotoCount,
      suggested_review_action: suggestedActionForBucket(bucket),
      claim_meaning: claimMeaningForBucket(bucket),
      label: slip?.label ?? ep?.label ?? lineLabel(grain),
      slip_content_ids: slip?.slip_content_ids ?? [],
      expected_package_ids: ep?.expected_package_ids ?? [],
      return_item_ids: scan?.return_item_ids ?? [],
    });
  }

  lines.sort((a, b) => (a.label ?? a.grain_key).localeCompare(b.label ?? b.grain_key));

  const bucket_counts = emptyBucketCounts();
  for (const line of lines) {
    bucket_counts[line.bucket] += 1;
  }

  return {
    phase: "6E-A",
    read_only: true,
    scope_kind: scopeKind,
    organization_id: orgId,
    store_id: storeId,
    pallet_id: input.palletId && isUuidString(String(input.palletId)) ? String(input.palletId) : null,
    tracking_number:
      scopeKind === "shipment_tracking" ? String(input.trackingNumber ?? "").trim() || null : trackings[0] ?? null,
    tracking_numbers: trackings,
    package_count: packages.length,
    lines,
    bucket_counts,
    totals: {
      shipment_expected_units: lines.reduce((s, l) => s + l.expected_qty, 0),
      slip_units: lines.reduce((s, l) => s + l.slip_qty, 0),
      scanned_units: lines.reduce((s, l) => s + l.scanned_qty, 0),
      off_manifest_units: lines.reduce((s, l) => s + l.off_manifest_scanned_qty, 0),
      operator_note_missing_units: lines.reduce((s, l) => s + l.operator_note_missing_qty, 0),
      problem_item_units: lines.reduce((s, l) => s + l.problem_item_qty, 0),
    },
  };
}
