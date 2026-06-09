import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeTrackingKey, slipIdLookupCandidates, trackingKeysEqual } from "@/lib/scanner/tracking-normalize";

const PACKAGE_DETAIL_SELECT =
  "id, organization_id, store_id, pallet_id, package_code, id_slip_contents, tracking_number, rma_number, expected_item_count, actual_item_count, status";

/**
 * Indexed package lookup: exact equality on tracking candidates, then case-insensitive ilike fallback.
 * Replaces full-table pagination over `packages`.
 */
export async function findPackageIdsByTrackingForStore(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
): Promise<string[]> {
  const trimmed = String(trackingNumber ?? "").trim();
  const key = normalizeTrackingKey(trimmed);
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!key || !orgId || !sid) return [];

  const ids = new Set<string>();

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

  if (trimmed) {
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
  }

  return [...ids];
}

/** Package ids for an indexed slip / package_code lookup. */
export async function findPackageIdsByColumnForStore(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  column: "id_slip_contents" | "package_code",
  value: string,
): Promise<string[]> {
  const trimmed = String(value ?? "").trim();
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!trimmed || !orgId || !sid) return [];

  const { data, error } = await supabase
    .from("packages")
    .select("id")
    .eq("organization_id", orgId)
    .eq("store_id", sid)
    .eq(column, trimmed)
    .is("deleted_at", null);
  if (error) throw error;
  return (data ?? []).map((row) => String((row as { id: string }).id));
}

/**
 * Single indexed query for slip scrub: packages matching slip code OR any listed tracking numbers.
 */
export async function findPackageIdsForSlipContext(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  slipCode: string,
  trackingNumbers: string[],
): Promise<string[]> {
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  const slip = String(slipCode ?? "").trim();
  const trackings = [...new Set(trackingNumbers.map((t) => String(t ?? "").trim()).filter(Boolean))];
  if (!orgId || !sid || (!slip && !trackings.length)) return [];

  const orParts: string[] = [];
  if (slip) orParts.push(`id_slip_contents.eq.${slip}`);
  if (trackings.length) orParts.push(`tracking_number.in.(${trackings.join(",")})`);
  if (!orParts.length) return [];

  const { data, error } = await supabase
    .from("packages")
    .select("id")
    .eq("organization_id", orgId)
    .eq("store_id", sid)
    .is("deleted_at", null)
    .or(orParts.join(","));
  if (error) throw error;
  return (data ?? []).map((row) => String((row as { id: string }).id));
}

/** First active package row matching tracking (indexed path). */
export async function findFirstPackageByTrackingNormalized(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  code: string,
): Promise<Record<string, unknown> | undefined> {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return undefined;

  const orgId = organizationId.trim();
  const sid = String(storeId ?? "").trim();

  if (sid) {
    const ids = await findPackageIdsByTrackingForStore(supabase, orgId, sid, trimmed);
    if (ids.length) {
      const { data, error } = await supabase
        .from("packages")
        .select(PACKAGE_DETAIL_SELECT)
        .eq("id", ids[0]!)
        .is("deleted_at", null)
        .limit(1);
      if (error) throw error;
      return data?.[0] as Record<string, unknown> | undefined;
    }
  }

  for (const candidate of slipIdLookupCandidates(trimmed, normalizeTrackingKey(trimmed))) {
    const { data, error } = await supabase
      .from("packages")
      .select(PACKAGE_DETAIL_SELECT)
      .eq("organization_id", orgId)
      .eq("tracking_number", candidate)
      .is("deleted_at", null)
      .limit(5);
    if (error) throw error;
    const hit = (data ?? []).find((row) =>
      trackingKeysEqual(String((row as { tracking_number?: string | null }).tracking_number ?? ""), trimmed),
    );
    if (hit) return hit as Record<string, unknown>;
  }

  return undefined;
}

/** Whether an active package exists for tracking, package_code, or slip id. */
export async function hasActivePackageForScanCode(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  code: string,
): Promise<boolean> {
  const trimmed = String(code ?? "").trim();
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!trimmed || !orgId || !sid) return false;

  for (const column of ["package_code", "id_slip_contents", "tracking_number"] as const) {
    const { data, error } = await supabase
      .from("packages")
      .select("id")
      .eq("organization_id", orgId)
      .eq("store_id", sid)
      .eq(column, trimmed)
      .is("deleted_at", null)
      .limit(1);
    if (error) throw error;
    if ((data ?? []).length > 0) return true;
  }

  const ids = await findPackageIdsByTrackingForStore(supabase, orgId, sid, trimmed);
  return ids.length > 0;
}
