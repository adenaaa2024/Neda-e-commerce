import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EXPECTED_PACKAGE_UI_COPY,
  hasAmazonSourceMismatch,
  splitExpectedQuantityByBuildStatus,
} from "@/lib/expected-packages-conflict-status";
import { scrubInventoryRowsExcludingVoidedPackages } from "@/lib/scanner/operator-active-scanned-counts";
import { mockExpectedPackageDetailRows, type FetchExpectedPackagesOptions } from "@/lib/scanner/operator-tracking-expectations";
import { fetchIdentityStatusForScanCode } from "@/lib/scanner/scanner-identity-lookup";
import { normalizeTrackingKey, slipIdLookupCandidates, trackingKeysEqual } from "@/lib/scanner/tracking-normalize";

/** Readable message from Supabase/PostgREST throws (plain objects or Error). */
export function formatSupabaseActionError(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message.trim()) return e.message.trim();
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts: string[] = [];
    if (typeof o.message === "string" && o.message.trim()) parts.push(o.message.trim());
    if (typeof o.details === "string" && o.details.trim()) parts.push(o.details.trim());
    if (typeof o.hint === "string" && o.hint.trim()) parts.push(o.hint.trim());
    if (typeof o.code === "string" && o.code.trim()) parts.push(`(${o.code})`);
    if (parts.length) return parts.join(" — ");
  }
  return fallback;
}

const V_INVENTORY_STATUS = "v_inventory_status" as const;
const V_INVENTORY_ITEM_STATUS = "v_inventory_item_status" as const;

/** Narrow select — avoids heavy view payloads on mobile gate reads. */
const INVENTORY_VIEW_GATE_SELECT =
  "expected_package_id, organization_id, store_id, tracking_number, id_slip_contents, sku, fnsku, asin, order_id, status, product_name, product_id, resolved_product_id, resolved_catalog_product_id, product_linkage_status, identifier_resolution_status, identifier_resolution_confidence, carrier, total_expected, total_scanned";

/** Which column matched the operator scan (exact equality). Slip “ASIN” column values are stored as `fnsku`. */
export type InventoryViewMatchField = "fnsku" | "sku" | "tracking_number" | "id_slip_contents";

/** Row shape from `public.v_inventory_item_status` (operator identification gate). */
export type VInventoryStatusRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string;
  tracking_number: string | null;
  /** `expected_packages.id_slip_contents` when exposed on the inventory view. */
  id_slip_contents: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  order_id: string | null;
  /** Present on the view when exposed; omitted from search filters to avoid legacy column errors. */
  status: string | null;
  product_name: string | null;
  /** Optional view alias for catalog display name when exposed. */
  product_display_name: string | null;
  product_id: string | null;
  /** Map/read-layer or persisted resolver output when view exposes it. */
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  /** View column `product_linkage_status` or resolver status when present. */
  product_linkage_status: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
  carrier: string | null;
  /** Clean expected quantity for gate progress — excludes disputed/source-conflict EP rows. */
  total_expected: number;
  total_scanned: number;
  /** Explicit clean expected; mirrors total_expected when conflict gating applied. */
  expected_clean?: number;
  /** Disputed quantity requiring source reconciliation; never added into total_expected. */
  disputed_quantity?: number;
  needs_reconciliation?: boolean;
  reconciliation_message?: string | null;
  /** Present when multiple raw EP/view rows were merged for Shipment Entry display. */
  display_group?: InventoryDisplayGroupMeta | null;
};

/** Audit metadata for grouped Shipment Entry line cards (raw EP rows remain unchanged in DB). */
export type InventoryDisplayGroupMeta = {
  source_line_count: number;
  source_expected_package_ids: string[];
  build_statuses: string[];
  has_source_split: boolean;
  has_overflow_conflict: boolean;
  has_matched: boolean;
  expected_clean_total?: number;
  disputed_quantity_total?: number;
  has_disputed?: boolean;
  needs_reconciliation?: boolean;
  amazon_source_mismatch?: boolean;
};

export type InventoryGateVisualStatus =
  | "new"
  | "manual_new"
  | "unexpected"
  | "in_progress"
  | "completed"
  | "over_scanned";

function coerceInt(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

/** Resolve line PK from view/API rows — different deployments expose different column names. */
function resolveExpectedPackageLineId(r: Record<string, unknown>): string {
  const keys = [
    "expected_package_id",
    "expected_packages_id",
    "expected_package_pk",
    "id",
    "line_id",
    "inventory_line_id",
  ] as const;
  for (const k of keys) {
    const v = r[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function rowFromRecord(r: Record<string, unknown>): VInventoryStatusRow {
  const confRaw = r.identifier_resolution_confidence;
  let conf: number | null = null;
  if (confRaw != null && confRaw !== "") {
    const n = Number(confRaw);
    if (Number.isFinite(n)) conf = n;
  }
  return {
    expected_package_id: resolveExpectedPackageLineId(r),
    organization_id: String(r.organization_id ?? ""),
    store_id: String(r.store_id ?? ""),
    tracking_number: r.tracking_number != null ? String(r.tracking_number) : null,
    id_slip_contents:
      r.id_slip_contents != null
        ? String(r.id_slip_contents)
        : r.slip_code != null
          ? String(r.slip_code)
          : null,
    sku: r.sku != null ? String(r.sku) : null,
    fnsku: r.fnsku != null ? String(r.fnsku) : null,
    asin: r.asin != null ? String(r.asin) : null,
    order_id: r.order_id != null ? String(r.order_id) : null,
    status: r.status != null ? String(r.status) : null,
    product_name: r.product_name != null ? String(r.product_name) : null,
    product_display_name:
      r.product_display_name != null
        ? String(r.product_display_name)
        : r.product_name != null
          ? String(r.product_name)
          : null,
    product_id: r.product_id != null ? String(r.product_id) : null,
    resolved_product_id:
      r.resolved_product_id != null && String(r.resolved_product_id).trim()
        ? String(r.resolved_product_id).trim()
        : null,
    resolved_catalog_product_id:
      r.resolved_catalog_product_id != null ? String(r.resolved_catalog_product_id) : null,
    product_linkage_status:
      r.product_linkage_status != null
        ? String(r.product_linkage_status)
        : r.identifier_resolution_status != null
          ? String(r.identifier_resolution_status)
          : null,
    identifier_resolution_status:
      r.identifier_resolution_status != null
        ? String(r.identifier_resolution_status)
        : r.product_linkage_status != null
          ? String(r.product_linkage_status)
          : null,
    identifier_resolution_confidence: conf,
    carrier: r.carrier != null ? String(r.carrier) : null,
    total_expected: coerceInt(r.total_expected),
    total_scanned: coerceInt(r.total_scanned),
  };
}

function mergeUniqueByPackageId(rows: VInventoryStatusRow[]): VInventoryStatusRow[] {
  const byId = new Map<string, VInventoryStatusRow>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let id = row.expected_package_id.trim();
    if (!id) {
      id = [
        row.tracking_number ?? "",
        row.sku ?? "",
        row.fnsku ?? "",
        row.asin ?? "",
        String(row.total_expected),
        String(row.total_scanned),
        String(i),
      ].join("\u0000");
    }
    if (!byId.has(id)) byId.set(id, row);
  }
  return [...byId.values()];
}

export function resolveInventoryExpectedClean(row: VInventoryStatusRow): number {
  if (row.expected_clean != null && Number.isFinite(row.expected_clean)) {
    return Math.max(0, Math.trunc(row.expected_clean));
  }
  return Math.max(0, row.total_expected);
}

export function resolveInventoryDisputedQuantity(row: VInventoryStatusRow): number {
  if (row.disputed_quantity != null && Number.isFinite(row.disputed_quantity)) {
    return Math.max(0, Math.trunc(row.disputed_quantity));
  }
  return 0;
}

export function aggregateInventoryStatus(rows: VInventoryStatusRow[]): {
  rowCount: number;
  totalExpected: number;
  totalScanned: number;
  totalDisputed: number;
} {
  let totalExpected = 0;
  let totalScanned = 0;
  let totalDisputed = 0;
  for (const r of rows) {
    totalExpected += resolveInventoryExpectedClean(r);
    totalScanned += Math.max(0, r.total_scanned);
    totalDisputed += resolveInventoryDisputedQuantity(r);
  }
  return { rowCount: rows.length, totalExpected, totalScanned, totalDisputed };
}

function normId(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

function normProductToken(v: string | null | undefined): string {
  return String(v ?? "").trim().toUpperCase();
}

function inventoryProductScopeKey(row: Pick<VInventoryStatusRow, "resolved_product_id" | "product_id" | "fnsku" | "sku" | "asin">): string {
  const resolved = normId(row.resolved_product_id ?? row.product_id);
  if (resolved) return `pid:${resolved}`;
  const fnsku = normProductToken(row.fnsku);
  const sku = normProductToken(row.sku);
  const asin = normProductToken(row.asin);
  return [fnsku, sku, asin].filter(Boolean).join("|") || "unknown";
}

/**
 * Display grouping key for Shipment Entry — aligned with `v_inventory_item_status` item_grouped grain
 * plus order_id and resolved_product_id when present.
 */
export function inventoryDisplayGroupKey(row: VInventoryStatusRow): string {
  const trackingRaw = String(row.tracking_number ?? "").trim();
  const tracking = normalizeTrackingKey(trackingRaw) || trackingRaw;
  return [
    normId(row.organization_id),
    normId(row.store_id),
    tracking,
    normId(row.order_id),
    inventoryProductScopeKey(row),
    normId(row.id_slip_contents),
    normId(row.carrier),
  ].join("\u0000");
}

function buildDisplayGroupConflictMeta(
  buildStatuses: string[],
  expectedClean: number,
  disputedQuantity: number,
): Pick<
  InventoryDisplayGroupMeta,
  | "expected_clean_total"
  | "disputed_quantity_total"
  | "has_disputed"
  | "needs_reconciliation"
  | "amazon_source_mismatch"
  | "has_overflow_conflict"
  | "has_matched"
> {
  const hasOverflowConflict = buildStatuses.some((s) => s.trim() === "shipment_overflow_conflict");
  const hasMatched = buildStatuses.some((s) => s.trim() === "matched");
  const hasDisputed = disputedQuantity > 0 || hasAmazonSourceMismatch(buildStatuses);
  return {
    expected_clean_total: expectedClean,
    disputed_quantity_total: disputedQuantity,
    has_disputed: hasDisputed,
    needs_reconciliation: hasDisputed,
    amazon_source_mismatch: hasAmazonSourceMismatch(buildStatuses),
    has_overflow_conflict: hasOverflowConflict,
    has_matched: hasMatched,
  };
}

function applyConflictGatingFieldsToRow(
  row: VInventoryStatusRow,
  expectedClean: number,
  disputedQuantity: number,
  display_group: InventoryDisplayGroupMeta,
): VInventoryStatusRow {
  const needsReconciliation = disputedQuantity > 0 || Boolean(display_group.needs_reconciliation);
  const reconciliationMessage = needsReconciliation
    ? display_group.amazon_source_mismatch
      ? EXPECTED_PACKAGE_UI_COPY.amazonSourceMismatch
      : display_group.has_overflow_conflict
        ? EXPECTED_PACKAGE_UI_COPY.shipmentDetailQtyDisagree
        : EXPECTED_PACKAGE_UI_COPY.needsReconciliation
    : null;
  return {
    ...row,
    expected_clean: expectedClean,
    disputed_quantity: disputedQuantity,
    needs_reconciliation: needsReconciliation,
    reconciliation_message: reconciliationMessage,
    total_expected: expectedClean,
    display_group,
  };
}

function mergeDisplayGroupMeta(parts: (InventoryDisplayGroupMeta | null | undefined)[]): InventoryDisplayGroupMeta {
  const epIds = new Set<string>();
  const buildStatuses = new Set<string>();
  let sourceLineCount = 0;
  let expectedCleanTotal = 0;
  let disputedQuantityTotal = 0;
  for (const part of parts) {
    if (!part) continue;
    sourceLineCount += Math.max(1, part.source_line_count);
    expectedCleanTotal += Math.max(0, part.expected_clean_total ?? 0);
    disputedQuantityTotal += Math.max(0, part.disputed_quantity_total ?? 0);
    for (const id of part.source_expected_package_ids) {
      const trimmed = id.trim();
      if (trimmed) epIds.add(trimmed);
    }
    for (const status of part.build_statuses) {
      const trimmed = status.trim();
      if (trimmed) buildStatuses.add(trimmed);
    }
  }
  const statuses = [...buildStatuses];
  const hasSourceSplit = sourceLineCount > 1 || epIds.size > 1 || statuses.length > 1;
  const conflictMeta = buildDisplayGroupConflictMeta(statuses, expectedCleanTotal, disputedQuantityTotal);
  return {
    source_line_count: Math.max(sourceLineCount, parts.filter(Boolean).length, epIds.size || 0, 1),
    source_expected_package_ids: [...epIds],
    build_statuses: statuses,
    has_source_split: hasSourceSplit,
    ...conflictMeta,
  };
}

function deriveInventoryLineStatusFromTotals(expected: number, scanned: number): string | null {
  const te = Math.max(0, coerceInt(expected));
  const ts = Math.max(0, coerceInt(scanned));
  if (te <= 0 && ts <= 0) return "not_registered";
  if (te <= 0 && ts > 0) return "in_progress_not";
  if (te > 0 && ts === 0) return "expected";
  if (te > 0 && ts < te) return "in_progress";
  if (te > 0 && ts === te) return "complete";
  if (te > 0 && ts > te) return "unexpected";
  return null;
}

function pickPreferredInventoryField<T>(values: T[], pick: (v: T) => boolean): T | null {
  for (const value of values) {
    if (pick(value)) return value;
  }
  return values[0] ?? null;
}

/** Merge duplicate operational product lines for Shipment Entry display (read-model only). */
export function groupInventoryStatusRowsForDisplay(rows: VInventoryStatusRow[]): VInventoryStatusRow[] {
  if (rows.length <= 1) return rows;
  const groups = new Map<string, VInventoryStatusRow[]>();
  for (const row of rows) {
    const key = inventoryDisplayGroupKey(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  if (groups.size === rows.length) return rows;

  const merged: VInventoryStatusRow[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      merged.push(bucket[0]!);
      continue;
    }
    let totalExpectedClean = 0;
    let totalDisputed = 0;
    let totalScanned = 0;
    for (const row of bucket) {
      totalExpectedClean += resolveInventoryExpectedClean(row);
      totalDisputed += resolveInventoryDisputedQuantity(row);
      totalScanned += Math.max(0, row.total_scanned);
    }
    const epIds = bucket
      .map((row) => row.expected_package_id.trim())
      .filter(Boolean);
    const display_group = mergeDisplayGroupMeta(
      bucket.map((row) =>
        row.display_group ?? {
          source_line_count: 1,
          source_expected_package_ids: row.expected_package_id.trim() ? [row.expected_package_id.trim()] : [],
          build_statuses: [],
          has_source_split: false,
          has_overflow_conflict: false,
          has_matched: false,
          expected_clean_total: resolveInventoryExpectedClean(row),
          disputed_quantity_total: resolveInventoryDisputedQuantity(row),
        },
      ),
    );
    merged.push(
      applyConflictGatingFieldsToRow(
        {
          ...bucket[0]!,
          expected_package_id: epIds.length === 1 ? epIds[0]! : "",
          asin: pickPreferredInventoryField(
            bucket.map((row) => row.asin),
            (v) => Boolean(v?.trim()),
          ),
          product_name: pickPreferredInventoryField(
            bucket.map((row) => row.product_name),
            (v) => Boolean(v?.trim()),
          ),
          product_display_name: pickPreferredInventoryField(
            bucket.map((row) => row.product_display_name),
            (v) => Boolean(v?.trim()),
          ),
          resolved_product_id: pickPreferredInventoryField(
            bucket.map((row) => row.resolved_product_id),
            (v) => Boolean(v?.trim()),
          ),
          resolved_catalog_product_id: pickPreferredInventoryField(
            bucket.map((row) => row.resolved_catalog_product_id),
            (v) => Boolean(v?.trim()),
          ),
          product_linkage_status: pickPreferredInventoryField(
            bucket.map((row) => row.product_linkage_status),
            (v) => Boolean(v?.trim()),
          ),
          identifier_resolution_status: pickPreferredInventoryField(
            bucket.map((row) => row.identifier_resolution_status),
            (v) => Boolean(v?.trim()),
          ),
          identifier_resolution_confidence: pickPreferredInventoryField(
            bucket.map((row) => row.identifier_resolution_confidence),
            (v) => v != null,
          ),
          status:
            pickPreferredInventoryField(
              bucket.map((row) => row.status),
              (v) => Boolean(v?.trim()),
            ) ?? deriveInventoryLineStatusFromTotals(totalExpectedClean, totalScanned),
          total_expected: totalExpectedClean,
          total_scanned: totalScanned,
          display_group,
        },
        totalExpectedClean,
        totalDisputed,
        display_group,
      ),
    );
  }
  merged.sort((a, b) => {
    const af = normProductToken(a.fnsku) || normProductToken(a.sku);
    const bf = normProductToken(b.fnsku) || normProductToken(b.sku);
    return af.localeCompare(bf, undefined, { sensitivity: "base" });
  });
  return merged;
}

/** Final Shipment Entry read-model rows — idempotent when view already aggregated. */
export function finalizeInventoryGateDisplayRows(rows: VInventoryStatusRow[]): VInventoryStatusRow[] {
  return groupInventoryStatusRowsForDisplay(rows);
}

/**
 * Re-apply clean/disputed split from raw expected_packages rows (read-only enrichment).
 * Preserves scanned totals from inventory view rows when group keys align.
 */
export function mergeInventoryRowsWithExpectedPackageBuildStatus(
  viewRows: VInventoryStatusRow[],
  epRows: Record<string, unknown>[],
  orgId: string,
  storeId: string,
): VInventoryStatusRow[] {
  if (!epRows.length || !viewRows.length) return viewRows;
  const hasBuildStatus = epRows.some((r) =>
    String((r as { build_status?: string | null }).build_status ?? "").trim(),
  );
  if (!hasBuildStatus) return viewRows;

  const aggregated = aggregateExpectedPackageRowsForInventoryDisplay(epRows, orgId, storeId);
  if (!aggregated.length) return viewRows;

  const scannedByKey = new Map<string, number>();
  for (const row of viewRows) {
    const key = inventoryDisplayGroupKey(row);
    scannedByKey.set(key, (scannedByKey.get(key) ?? 0) + Math.max(0, row.total_scanned));
  }

  return aggregated.map((row) => {
    const key = inventoryDisplayGroupKey(row);
    const scanned = scannedByKey.get(key);
    if (scanned == null) return row;
    const clean = resolveInventoryExpectedClean(row);
    return {
      ...row,
      total_scanned: scanned,
      status: deriveInventoryLineStatusFromTotals(clean, scanned),
    };
  });
}

export function inventoryDisplayGroupBadgeLabels(meta: InventoryDisplayGroupMeta | null | undefined): string[] {
  if (!meta) return [];
  const labels: string[] = [];
  if (meta.has_matched) labels.push("matched");
  if (meta.needs_reconciliation || meta.has_disputed) {
    labels.push(EXPECTED_PACKAGE_UI_COPY.needsReconciliation);
  } else if (meta.has_overflow_conflict) {
    labels.push(EXPECTED_PACKAGE_UI_COPY.needsReconciliation);
  }
  if (meta.amazon_source_mismatch) labels.push(EXPECTED_PACKAGE_UI_COPY.amazonSourceMismatch);
  if (meta.has_overflow_conflict) labels.push(EXPECTED_PACKAGE_UI_COPY.shipmentDetailQtyDisagree);
  if (meta.has_source_split) labels.push("source split");
  return labels;
}

/** Map raw `expected_packages` rows to grouped gate inventory lines (no DB writes). */
export function aggregateExpectedPackageRowsForInventoryDisplay(
  rows: Record<string, unknown>[],
  orgId: string,
  storeId: string,
): VInventoryStatusRow[] {
  type Acc = {
    tracking: string;
    slip: string;
    sku: string;
    fnsku: string;
    asin: string;
    orderId: string;
    carrier: string;
    expectedClean: number;
    expectedDisputed: number;
    scanned: number;
    epIds: Set<string>;
    buildStatuses: Set<string>;
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
  };
  const groups = new Map<string, Acc>();

  for (const r of rows) {
    const trackingRaw = String((r as { tracking_number?: string | null }).tracking_number ?? "").trim();
    const tracking = normalizeTrackingKey(trackingRaw) || trackingRaw;
    const slip = String((r as { id_slip_contents?: string | null }).id_slip_contents ?? "").trim();
    const sku = String((r as { sku?: string | null }).sku ?? "").trim();
    const fnsku = String((r as { fnsku?: string | null }).fnsku ?? "").trim();
    const asin = String((r as { asin?: string | null }).asin ?? "").trim();
    const orderId = String((r as { order_id?: string | null }).order_id ?? "").trim().toLowerCase();
    const carrier = String((r as { carrier?: string | null }).carrier ?? "").trim().toLowerCase();
    const resolvedProductId = String((r as { resolved_product_id?: string | null }).resolved_product_id ?? "")
      .trim()
      .toLowerCase();
    const productKey =
      resolvedProductId ||
      [fnsku.toUpperCase(), sku.toUpperCase(), asin.toUpperCase()].filter(Boolean).join("|") ||
      "unknown";
    const key = [orgId, storeId, tracking, orderId, productKey, slip.toLowerCase(), carrier].join("\u0000");
    const exp = coerceInt((r as { expected_scan_quantity?: number }).expected_scan_quantity);
    const act = coerceInt((r as { actual_scanned_count?: number }).actual_scanned_count);
    const epId = String((r as { id?: string }).id ?? "").trim();
    const buildStatus = String((r as { build_status?: string | null }).build_status ?? "").trim();

    const split = splitExpectedQuantityByBuildStatus(buildStatus, exp);

    const prev = groups.get(key);
    if (prev) {
      prev.expectedClean += split.clean;
      prev.expectedDisputed += split.disputed;
      prev.scanned += act;
      if (epId) prev.epIds.add(epId);
      if (buildStatus) prev.buildStatuses.add(buildStatus);
      if (asin && !prev.asin) prev.asin = asin;
      if ((r as { order_id?: string | null }).order_id) {
        prev.orderId = String((r as { order_id?: string | null }).order_id);
      }
    } else {
      groups.set(key, {
        tracking,
        slip,
        sku,
        fnsku,
        asin,
        orderId: String((r as { order_id?: string | null }).order_id ?? "").trim(),
        carrier,
        expectedClean: split.clean,
        expectedDisputed: split.disputed,
        scanned: act,
        epIds: new Set(epId ? [epId] : []),
        buildStatuses: new Set(buildStatus ? [buildStatus] : []),
        resolved_product_id: (r as { resolved_product_id?: string | null }).resolved_product_id ?? null,
        resolved_catalog_product_id:
          (r as { resolved_catalog_product_id?: string | null }).resolved_catalog_product_id ?? null,
        identifier_resolution_status:
          (r as { identifier_resolution_status?: string | null }).identifier_resolution_status ?? null,
        identifier_resolution_confidence:
          (r as { identifier_resolution_confidence?: number | null }).identifier_resolution_confidence ?? null,
      });
    }
  }

  const out: VInventoryStatusRow[] = [];
  for (const g of groups.values()) {
    const epIds = [...g.epIds];
    const buildStatuses = [...g.buildStatuses];
    const conflictMeta = buildDisplayGroupConflictMeta(buildStatuses, g.expectedClean, g.expectedDisputed);
    const display_group: InventoryDisplayGroupMeta = {
      source_line_count: Math.max(epIds.length, 1),
      source_expected_package_ids: epIds,
      build_statuses: buildStatuses,
      has_source_split: epIds.length > 1 || buildStatuses.length > 1,
      ...conflictMeta,
    };
    out.push(
      applyConflictGatingFieldsToRow(
        {
          expected_package_id: epIds.length === 1 ? epIds[0]! : "",
          organization_id: orgId,
          store_id: storeId,
          tracking_number: g.tracking || null,
          id_slip_contents: g.slip || null,
          sku: g.sku || null,
          fnsku: g.fnsku || null,
          asin: g.asin || null,
          order_id: g.orderId || null,
          status: deriveInventoryLineStatusFromTotals(g.expectedClean, g.scanned),
          product_name: null,
          product_display_name: null,
          product_id: null,
          resolved_product_id: g.resolved_product_id,
          resolved_catalog_product_id: g.resolved_catalog_product_id,
          product_linkage_status: g.identifier_resolution_status,
          identifier_resolution_status: g.identifier_resolution_status,
          identifier_resolution_confidence: g.identifier_resolution_confidence,
          carrier: g.carrier || null,
          total_expected: g.expectedClean,
          total_scanned: g.scanned,
          display_group,
        },
        g.expectedClean,
        g.expectedDisputed,
        display_group,
      ),
    );
  }
  out.sort((a, b) => {
    const af = normProductToken(a.fnsku) || normProductToken(a.sku);
    const bf = normProductToken(b.fnsku) || normProductToken(b.sku);
    return af.localeCompare(bf, undefined, { sensitivity: "base" });
  });
  return out;
}

/** Map `status` from the unified inventory view to gate glow / badge theme. */
export function mapInventoryViewStatusToVisual(status: string | null | undefined): InventoryGateVisualStatus | null {
  const s = String(status ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (s === "new") return "new";
  if (s === "unexpected") return "unexpected";
  if (s === "in_progress") return "in_progress";
  if (s === "completed") return "completed";
  if (s === "over_scanned") return "over_scanned";
  if (s === "manual_new") return "manual_new";
  return null;
}

/**
 * Derive gate visuals from totals so stale view labels cannot mark an unscanned
 * expected shipment as in progress.
 * Zero rows → manual_new (off manifest).
 */
export function resolveInventoryGateVisualStatus(
  rows: VInventoryStatusRow[],
  agg: { rowCount: number; totalExpected: number; totalScanned: number },
): InventoryGateVisualStatus {
  if (rows.length === 0) return "manual_new";
  return deriveInventoryGateVisualStatus(agg);
}

/**
 * Maps aggregated inventory totals to Identification Gate UI states.
 * Treats NULL / zero expected as 0 for comparisons (safe for "new" / orphan lines).
 */
export function deriveInventoryGateVisualStatus(agg: {
  rowCount: number;
  totalExpected: number;
  totalScanned: number;
}): InventoryGateVisualStatus {
  const te = Math.max(0, coerceInt(agg.totalExpected));
  const ts = Math.max(0, coerceInt(agg.totalScanned));
  if (agg.rowCount === 0) return "manual_new";
  if (te <= 0) return "unexpected";
  if (ts === 0) return "new";
  if (ts >= te) return "completed";
  return "in_progress";
}

/** Progress bar fill 0–100; denominator 0 or non-finite → 0% (no crash). */
export function safeInventoryProgressPercent(totalScanned: number, totalExpected: number): number {
  const te = Math.max(0, coerceInt(totalExpected));
  const ts = Math.max(0, coerceInt(totalScanned));
  if (te <= 0) return 0;
  return Math.min(100, Math.round((ts / te) * 100));
}

export function formatInventoryProgressLabel(totalScanned: number, totalExpected: number): string {
  const te = Math.max(0, coerceInt(totalExpected));
  const ts = Math.max(0, coerceInt(totalScanned));
  const denom = te > 0 ? te : 0;
  return `${ts} / ${denom}`;
}

/** Demo-mode inventory rows derived from `mockExpectedPackageDetailRows`. */
function mockRowStatusFromQuantities(expected: number, scanned: number): string {
  const te = Math.max(0, coerceInt(expected));
  const ts = Math.max(0, coerceInt(scanned));
  if (te <= 0) return "unexpected";
  if (ts > te) return "over_scanned";
  if (ts === te) return "completed";
  if (ts === 0) return "new";
  return "in_progress";
}

function epRowToInventoryStatusRow(r: Record<string, unknown>): VInventoryStatusRow {
  return {
    expected_package_id: String((r as { id?: string }).id ?? ""),
    organization_id: "",
    store_id: "",
    tracking_number: String(r.tracking_number ?? "").trim() || null,
    id_slip_contents:
      (r as { id_slip_contents?: string | null }).id_slip_contents != null
        ? String((r as { id_slip_contents?: string | null }).id_slip_contents)
        : (r as { slip_code?: string | null }).slip_code != null
          ? String((r as { slip_code?: string | null }).slip_code)
          : null,
    sku: String(r.sku ?? "").trim() || null,
    fnsku: String(r.fnsku ?? "").trim() || null,
    asin: String((r as { asin?: string | null }).asin ?? "").trim() || null,
    order_id: (r as { order_id?: string | null }).order_id != null ? String((r as { order_id?: string | null }).order_id) : null,
    status: null,
    product_name: null,
    product_display_name: null,
    product_id: null,
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
    total_expected: coerceInt((r as { expected_scan_quantity?: number }).expected_scan_quantity),
    total_scanned: coerceInt((r as { actual_scanned_count?: number }).actual_scanned_count),
  };
}

/** Demo shipment table lines — exact match on one view column. */
export function mockVInventoryItemStatusLinesForExact(
  field: InventoryViewMatchField,
  value: string,
): VInventoryStatusRow[] {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || /^NEW-/i.test(trimmed) || trimmed.length < 3) return [];

  const base = mockExpectedPackageDetailRows();
  const hit =
    field === "tracking_number"
      ? base.filter((r) => normalizeTrackingKey(String(r.tracking_number ?? "")) === normalizeTrackingKey(trimmed))
      : field === "id_slip_contents"
        ? base.filter((r) => {
            const v = String(
              (r as { id_slip_contents?: string | null }).id_slip_contents ??
                (r as { slip_code?: string | null }).slip_code ??
                "",
            ).trim();
            return v === trimmed;
          })
        : field === "fnsku"
          ? base.filter((r) => String((r as { fnsku?: string | null }).fnsku ?? "").trim() === trimmed)
          : base.filter((r) => String((r as { sku?: string | null }).sku ?? "").trim() === trimmed);

  return hit.map((r) => {
    const row = epRowToInventoryStatusRow(r as Record<string, unknown>);
    const exp = row.total_expected;
    const act = row.total_scanned;
    return {
      ...row,
      status: mockRowStatusFromQuantities(exp, act),
    };
  });
}

/** Demo gate search — same column priority as {@link fetchVInventoryStatusForScanCode}. */
export function mockVInventoryRowsForScanCode(rawCode: string): {
  rows: VInventoryStatusRow[];
  matchedField: InventoryViewMatchField | null;
} {
  const trimmed = String(rawCode ?? "").trim();
  if (!trimmed || /^NEW-/i.test(trimmed) || trimmed.length < 3) return { rows: [], matchedField: null };

  const base = mockExpectedPackageDetailRows();
  const byTn = base.filter((r) => String(r.tracking_number ?? "").trim() === trimmed);
  if (byTn.length) {
    return { rows: byTn.map((r) => epRowToInventoryStatusRow(r as Record<string, unknown>)), matchedField: "tracking_number" };
  }
  const bySlip = base.filter((r) => {
    const v = String(
      (r as { id_slip_contents?: string | null }).id_slip_contents ??
        (r as { slip_code?: string | null }).slip_code ??
        "",
    ).trim();
    return v === trimmed;
  });
  if (bySlip.length) {
    return { rows: bySlip.map((r) => epRowToInventoryStatusRow(r as Record<string, unknown>)), matchedField: "id_slip_contents" };
  }
  const byFnsku = base.filter((r) => String((r as { fnsku?: string | null }).fnsku ?? "").trim() === trimmed);
  if (byFnsku.length) {
    return { rows: byFnsku.map((r) => epRowToInventoryStatusRow(r as Record<string, unknown>)), matchedField: "fnsku" };
  }
  const bySku = base.filter((r) => String((r as { sku?: string | null }).sku ?? "").trim() === trimmed);
  if (bySku.length) {
    return { rows: bySku.map((r) => epRowToInventoryStatusRow(r as Record<string, unknown>)), matchedField: "sku" };
  }
  return { rows: [], matchedField: null };
}

/**
 * All line items from `v_inventory_item_status` with exact equality on one identifier column
 * (plus organization_id and store_id). No substring / fuzzy matching.
 */
export async function fetchVInventoryItemStatusLinesExact(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  field: InventoryViewMatchField,
  value: string,
): Promise<{ rows: VInventoryStatusRow[]; raw: unknown }> {
  const v = String(value ?? "").trim();
  if (!v) return { rows: [], raw: null };

  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!orgId || !sid) return { rows: [], raw: null };

  const { data, error } = await supabase
    .from(V_INVENTORY_ITEM_STATUS)
    .select("*")
    .eq("organization_id", orgId)
    .eq("store_id", sid)
    .eq(field, v);

  if (error) throw error;

  const arr: unknown[] = Array.isArray(data) ? data : [];
  const out: VInventoryStatusRow[] = [];
  for (const raw of arr) {
    if (raw && typeof raw === "object") out.push(rowFromRecord(raw as Record<string, unknown>));
  }
  const rows = await scrubInventoryRowsExcludingVoidedPackages(
    supabase,
    orgId,
    sid,
    out,
    field,
    v,
  );
  return { rows: finalizeInventoryGateDisplayRows(rows), raw: data };
}

function inventoryRowDedupeKey(row: VInventoryStatusRow, index: number): string {
  const id = row.expected_package_id.trim();
  if (id) return id;
  return [
    row.tracking_number ?? "",
    row.sku ?? "",
    row.fnsku ?? "",
    row.asin ?? "",
    String(row.total_expected),
    String(row.total_scanned),
    String(index),
  ].join("\u0000");
}

/**
 * Tracking lookup: exact equality on candidate strings first (indexed path), then a
 * bounded legacy scan only when stored tracking differs by case/whitespace from scan input.
 */
export async function fetchVInventoryItemStatusLinesForTrackingNormalized(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
): Promise<{ rows: VInventoryStatusRow[]; raw: unknown[] }> {
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  const trimmed = String(trackingNumber ?? "").trim();
  const key = normalizeTrackingKey(trimmed);
  if (!key || !orgId || !sid) return { rows: [], raw: [] };

  const merged: VInventoryStatusRow[] = [];
  const rawRows: unknown[] = [];
  const seen = new Set<string>();

  for (const candidate of slipIdLookupCandidates(trimmed, key)) {
    const hit = await fetchVInventoryItemStatusLinesExact(supabase, orgId, sid, "tracking_number", candidate);
    for (let i = 0; i < hit.rows.length; i++) {
      const row = hit.rows[i]!;
      if (!trackingKeysEqual(row.tracking_number, trimmed)) continue;
      const dedupe = inventoryRowDedupeKey(row, i);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      merged.push(row);
      if (Array.isArray(hit.raw)) {
        const rawArr = hit.raw as unknown[];
        if (rawArr[i]) rawRows.push(rawArr[i]);
      }
    }
    if (merged.length) break;
  }

  if (merged.length) {
    const scrubbed = await scrubInventoryRowsExcludingVoidedPackages(
      supabase,
      orgId,
      sid,
      merged,
      "tracking_number",
      trimmed,
    );
    return { rows: finalizeInventoryGateDisplayRows(scrubbed), raw: rawRows };
  }

  const rows: VInventoryStatusRow[] = [];
  const PAGE = 250;
  const MAX_ROWS = 1500;
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await supabase
      .from(V_INVENTORY_ITEM_STATUS)
      .select(INVENTORY_VIEW_GATE_SELECT)
      .eq("organization_id", orgId)
      .eq("store_id", sid)
      .not("tracking_number", "is", null)
      .range(off, off + PAGE - 1);

    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    for (const raw of page) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      if (normalizeTrackingKey(String(record.tracking_number ?? "")) !== key) continue;
      const row = rowFromRecord(record);
      const dedupe = inventoryRowDedupeKey(row, rows.length);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      rawRows.push(raw);
      rows.push(row);
    }
    if (!page.length || page.length < PAGE) break;
  }

  const scrubbed = await scrubInventoryRowsExcludingVoidedPackages(
    supabase,
    orgId,
    sid,
    rows,
    "tracking_number",
    trimmed,
  );
  return { rows: finalizeInventoryGateDisplayRows(scrubbed), raw: rawRows };
}

/** @deprecated Use {@link fetchVInventoryItemStatusLinesExact} */
export async function fetchVInventoryItemStatusByTracking(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  rawTracking: string,
): Promise<{ rows: VInventoryStatusRow[]; raw: unknown }> {
  return fetchVInventoryItemStatusLinesExact(supabase, organizationId, storeId, "tracking_number", rawTracking);
}

/**
 * Shipment Entry gate: indexed `expected_packages` identity lookup (Phase 9B).
 * Aggregate views (`v_inventory_*`) are reserved for progress/claims/dashboard reads.
 * Slip “ASIN” column values are FNSKUs — match `fnsku` before `sku` before carrier tracking.
 */
export async function fetchVInventoryStatusForScanCode(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  rawCode: string,
  options?: FetchExpectedPackagesOptions,
): Promise<{
  rows: VInventoryStatusRow[];
  raw: unknown;
  matchedField: InventoryViewMatchField | null;
  matchType?: import("@/lib/scanner/scanner-identity-gate-rpc").ScannerIdentityGateMatchType | null;
  scrubApplied?: boolean;
}> {
  return fetchIdentityStatusForScanCode(supabase, organizationId, storeId, rawCode, options);
}
