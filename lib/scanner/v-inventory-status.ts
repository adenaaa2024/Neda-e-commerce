import type { SupabaseClient } from "@supabase/supabase-js";
import { scrubInventoryRowsExcludingVoidedPackages } from "@/lib/scanner/operator-active-scanned-counts";
import { mockExpectedPackageDetailRows } from "@/lib/scanner/operator-tracking-expectations";
import { normalizeTrackingKey } from "@/lib/scanner/tracking-normalize";

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
  product_id: string | null;
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
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
    product_id: r.product_id != null ? String(r.product_id) : null,
    resolved_product_id: r.resolved_product_id != null ? String(r.resolved_product_id) : null,
    resolved_catalog_product_id:
      r.resolved_catalog_product_id != null ? String(r.resolved_catalog_product_id) : null,
    identifier_resolution_status:
      r.identifier_resolution_status != null
        ? String(r.identifier_resolution_status)
        : r.product_linkage_status != null
          ? String(r.product_linkage_status)
          : null,
    identifier_resolution_confidence:
      r.identifier_resolution_confidence != null && Number.isFinite(Number(r.identifier_resolution_confidence))
        ? Number(r.identifier_resolution_confidence)
        : null,
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
    product_id: null,
    resolved_product_id: (r as { resolved_product_id?: string | null }).resolved_product_id ?? null,
    resolved_catalog_product_id:
      (r as { resolved_catalog_product_id?: string | null }).resolved_catalog_product_id ?? null,
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
  const byFnsku = base.filter((r) => String((r as { fnsku?: string | null }).fnsku ?? "").trim() === trimmed);
  if (byFnsku.length) {
    return { rows: byFnsku.map((r) => epRowToInventoryStatusRow(r as Record<string, unknown>)), matchedField: "fnsku" };
  }
  const bySku = base.filter((r) => String((r as { sku?: string | null }).sku ?? "").trim() === trimmed);
  if (bySku.length) {
    return { rows: bySku.map((r) => epRowToInventoryStatusRow(r as Record<string, unknown>)), matchedField: "sku" };
  }
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

/**
 * Tracking lookup variant that compares normalized tracking keys in application code.
 * This keeps Shipment Entry totals scoped to the submitted tracking number even when
 * stored tracking values differ by case or whitespace.
 */
export async function fetchVInventoryItemStatusLinesForTrackingNormalized(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
): Promise<{ rows: VInventoryStatusRow[]; raw: unknown[] }> {
  const key = normalizeTrackingKey(trackingNumber);
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!key || !orgId || !sid) return { rows: [], raw: [] };

  const rows: VInventoryStatusRow[] = [];
  const rawRows: unknown[] = [];
  const PAGE = 500;
  for (let off = 0; off < 10000; off += PAGE) {
    const { data, error } = await supabase
      .from(V_INVENTORY_ITEM_STATUS)
      .select("*")
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
      rawRows.push(raw);
      rows.push(rowFromRecord(record));
    }
    if (!page.length || page.length < PAGE) break;
  }

  const scrubbed = await scrubInventoryRowsExcludingVoidedPackages(
    supabase,
    orgId,
    sid,
    rows,
    "tracking_number",
    trackingNumber,
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

async function fetchInventoryViewExact(
  supabase: SupabaseClient,
  viewName: typeof V_INVENTORY_STATUS | typeof V_INVENTORY_ITEM_STATUS,
  organizationId: string,
  storeId: string,
  field: InventoryViewMatchField,
  code: string,
): Promise<{ rows: VInventoryStatusRow[]; raw: unknown }> {
  const res = await supabase
    .from(viewName)
    .select("*")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq(field, code);
  if (res.error) throw res.error;
  const arr: unknown[] = Array.isArray(res.data) ? res.data : [];
  const out: VInventoryStatusRow[] = [];
  for (const raw of arr) {
    if (raw && typeof raw === "object") out.push(rowFromRecord(raw as Record<string, unknown>));
  }
  return { rows: mergeUniqueByPackageId(out), raw: res.data };
}

/**
 * Shipment Entry gate: query `v_inventory_status` then `v_inventory_item_status` (exact equality).
 * Slip “ASIN” column values are FNSKUs — match `fnsku` before `sku` before carrier tracking.
 */
export async function fetchVInventoryStatusForScanCode(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  rawCode: string,
): Promise<{ rows: VInventoryStatusRow[]; raw: unknown; matchedField: InventoryViewMatchField | null }> {
  const code = String(rawCode ?? "")
    .trim()
    .replace(/^[\s\uFEFF\xA0\u200B-\u200D]+|[\s\uFEFF\xA0\u200B-\u200D]+$/g, "");
  if (!code) return { rows: [], raw: null, matchedField: null };

  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!orgId || !sid) return { rows: [], raw: null, matchedField: null };

  const fieldOrder: InventoryViewMatchField[] = ["fnsku", "sku", "tracking_number", "id_slip_contents"];
  const views: (typeof V_INVENTORY_STATUS | typeof V_INVENTORY_ITEM_STATUS)[] = [
    V_INVENTORY_STATUS,
    V_INVENTORY_ITEM_STATUS,
  ];

  let matchedField: InventoryViewMatchField | null = null;
  let rows: VInventoryStatusRow[] = [];
  let raw: unknown = null;

  for (const field of fieldOrder) {
    for (const view of views) {
      if (view === V_INVENTORY_STATUS && field === "id_slip_contents") continue;
      try {
        const hit = await fetchInventoryViewExact(supabase, view, orgId, sid, field, code);
        if (hit.rows.length) {
          rows = await scrubInventoryRowsExcludingVoidedPackages(
            supabase,
            orgId,
            sid,
            hit.rows,
            field,
            code,
          );
          raw = hit.raw;
          matchedField = field;
          return { rows, raw, matchedField };
        }
      } catch (e) {
        const msg = formatSupabaseActionError(e, "");
        if (/does not exist|42P01|42703|column/i.test(msg)) continue;
        throw e;
      }
    }
  }

  return { rows: [], raw: null, matchedField: null };
}
