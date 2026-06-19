import type { SupabaseClient } from "@supabase/supabase-js";
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
  total_expected: number;
  total_scanned: number;
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

export function aggregateInventoryStatus(rows: VInventoryStatusRow[]): {
  rowCount: number;
  totalExpected: number;
  totalScanned: number;
} {
  let totalExpected = 0;
  let totalScanned = 0;
  for (const r of rows) {
    totalExpected += Math.max(0, r.total_expected);
    totalScanned += Math.max(0, r.total_scanned);
  }
  return { rowCount: rows.length, totalExpected, totalScanned };
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
  return { rows, raw: data };
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
    return { rows: scrubbed, raw: rawRows };
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
  return { rows: scrubbed, raw: rawRows };
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
