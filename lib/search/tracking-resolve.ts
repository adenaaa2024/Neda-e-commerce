/**
 * Phase 10 — eq-first tracking resolution for expected_packages and packages.
 * ILIKE / paginated scan only when deepSearch is explicitly enabled.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeTrackingKey,
  slipIdLookupCandidates,
  trackingKeysEqual,
} from "@/lib/scanner/tracking-normalize";

export type TrackingResolveOptions = {
  /** Allow ILIKE substring fallback and wide pagination (admin deep search only). */
  deepSearch?: boolean;
  /** Skip expensive ILIKE when code looks like carrier tracking (scanner fast-negative). */
  skipExpensiveFallback?: boolean;
};

export function isLikelyShipmentTrackingCode(code: string): boolean {
  const c = String(code ?? "").trim();
  if (c.length < 8) return false;
  if (/^1Z[A-Z0-9]{14,}/i.test(c)) return true;
  if (/^\d{12,22}$/.test(c)) return true;
  if (/^(94|92|93|95|89|91|82)\d{16,}/i.test(c)) return true;
  if (c.length >= 15 && /^[A-Z0-9]+$/i.test(c)) return true;
  return false;
}

export function shouldAllowTrackingIlikeFallback(
  scannedCode: string,
  options?: TrackingResolveOptions,
): boolean {
  if (!options?.deepSearch) return false;
  if (options.skipExpensiveFallback && isLikelyShipmentTrackingCode(scannedCode)) return false;
  return true;
}

function sanitizeTrackingForIlikePattern(scannedCode: string): string {
  return scannedCode.replace(/%/g, "").replace(/_/g, "");
}

function trackingRowMatchesScanned(
  row: { tracking_number?: string | null },
  normalizedKey: string,
): "exact" | "none" {
  const tn = String(row.tracking_number ?? "").trim();
  if (!tn || !normalizedKey) return "none";
  return trackingKeysEqual(tn, normalizedKey) ? "exact" : "none";
}

function asSafeRowArray(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

/**
 * Exact equality fetch on expected_packages.tracking_number (indexed).
 * Paginates fully — a single tracking may have hundreds of EP lines.
 */
export async function fetchExpectedPackagesByTrackingExact(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
  selectColumns: string,
): Promise<Record<string, unknown>[]> {
  const scannedCode = String(trackingNumber ?? "").trim();
  if (!scannedCode) return [];

  const key = normalizeTrackingKey(trackingNumber);
  const matchesExact = (row: { tracking_number?: string | null }) =>
    key ? trackingRowMatchesScanned(row, key) === "exact" : false;

  const EXACT_PAGE = 1000;
  const exactRows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += EXACT_PAGE) {
    const { data: exactPage, error: exactPageErr } = await supabase
      .from("expected_packages")
      .select(selectColumns)
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .eq("tracking_number", scannedCode)
      .order("id", { ascending: true })
      .range(from, from + EXACT_PAGE - 1);
    if (exactPageErr) throw exactPageErr;
    const pageRows = asSafeRowArray(exactPage);
    exactRows.push(...pageRows);
    if (pageRows.length < EXACT_PAGE) break;
  }
  return exactRows.filter((r) => matchesExact(r as { tracking_number?: string | null }));
}

async function fetchExpectedPackagesByTrackingIlike(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
  selectColumns: string,
): Promise<Record<string, unknown>[]> {
  const scannedCode = String(trackingNumber ?? "").trim();
  if (!scannedCode) return [];

  const cleanCode = scannedCode.replace(/[^a-zA-Z0-9]/g, "");
  const patternOriginal = sanitizeTrackingForIlikePattern(scannedCode);
  const key = normalizeTrackingKey(trackingNumber);
  const BASE_LIMIT = 800;
  const MAX_SCAN = 14_000;

  let qb = supabase
    .from("expected_packages")
    .select(selectColumns)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .limit(BASE_LIMIT);

  if (cleanCode.length > 0 && patternOriginal.length > 0 && cleanCode !== patternOriginal) {
    qb = qb.or(
      `tracking_number.ilike.%${cleanCode}%,tracking_number.ilike.%${patternOriginal}%`,
    );
  } else if (cleanCode.length > 0) {
    qb = qb.ilike("tracking_number", `%${cleanCode}%`);
  } else {
    qb = qb.ilike("tracking_number", `%${patternOriginal}%`);
  }

  const { data: ilikeBatch, error: ilikeErr } = await qb;
  if (ilikeErr) throw ilikeErr;

  const ilikeRows = asSafeRowArray(ilikeBatch);
  const filtered = key
    ? ilikeRows.filter((r) => trackingRowMatchesScanned(r as { tracking_number?: string | null }, key) !== "none")
    : ilikeRows;

  if (filtered.length || ilikeRows.length < BASE_LIMIT) return filtered;

  const merged: Record<string, unknown>[] = [...ilikeRows];
  for (let from = BASE_LIMIT; from < MAX_SCAN; from += BASE_LIMIT) {
    const { data: page, error } = await supabase
      .from("expected_packages")
      .select(selectColumns)
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .ilike("tracking_number", `%${cleanCode || patternOriginal}%`)
      .order("id", { ascending: true })
      .range(from, from + BASE_LIMIT - 1);
    if (error) throw error;
    const pageRows = asSafeRowArray(page);
    merged.push(...pageRows);
    if (pageRows.length < BASE_LIMIT) break;
  }

  return key
    ? merged.filter((r) => trackingRowMatchesScanned(r as { tracking_number?: string | null }, key) !== "none")
    : merged;
}

/** Eq-first expected_packages tracking lookup; ILIKE only when deepSearch is true. */
export async function resolveExpectedPackagesByTracking(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
  selectColumns: string,
  options?: TrackingResolveOptions,
): Promise<Record<string, unknown>[]> {
  const scannedCode = String(trackingNumber ?? "").trim();
  if (!scannedCode) return [];

  try {
    const exact = await fetchExpectedPackagesByTrackingExact(
      supabase,
      organizationId,
      storeId,
      scannedCode,
      selectColumns,
    );
    if (exact.length) return exact;
  } catch {
    /* fall through */
  }

  if (!shouldAllowTrackingIlikeFallback(scannedCode, options)) return [];

  return fetchExpectedPackagesByTrackingIlike(
    supabase,
    organizationId,
    storeId,
    scannedCode,
    selectColumns,
  );
}

/** Package ids by tracking — eq candidates first; ilike only for deepSearch. */
export async function resolvePackageIdsByTracking(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
  options?: TrackingResolveOptions,
): Promise<string[]> {
  const trimmed = String(trackingNumber ?? "").trim();
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!trimmed || !orgId || !sid) return [];

  const ids = new Set<string>();
  const key = normalizeTrackingKey(trimmed);

  for (const candidate of slipIdLookupCandidates(trimmed, key)) {
    const { data, error } = await supabase
      .from("packages")
      .select("id, tracking_number")
      .eq("organization_id", orgId)
      .eq("store_id", sid)
      .eq("tracking_number", candidate)
      .is("deleted_at", null);
    if (error) throw error;
    for (const row of data ?? []) {
      if (trackingKeysEqual((row as { tracking_number?: string | null }).tracking_number, trimmed)) {
        ids.add(String((row as { id: string }).id));
      }
    }
    if (ids.size) return [...ids];
  }

  if (!options?.deepSearch) return [];

  const { data, error } = await supabase
    .from("packages")
    .select("id, tracking_number")
    .eq("organization_id", orgId)
    .eq("store_id", sid)
    .is("deleted_at", null)
    .ilike("tracking_number", trimmed)
    .limit(50);
  if (error) throw error;
  for (const row of data ?? []) {
    if (trackingKeysEqual((row as { tracking_number?: string | null }).tracking_number, trimmed)) {
      ids.add(String((row as { id: string }).id));
    }
  }
  return [...ids];
}

/** Prefer exact tracking equality on inventory view filters; substring only for partial admin input. */
export function preferExactTrackingFilter(trackingInput: string): boolean {
  const tn = String(trackingInput ?? "").trim();
  if (!tn || tn.length < 8) return false;
  return isLikelyShipmentTrackingCode(tn) || !tn.includes("%");
}
