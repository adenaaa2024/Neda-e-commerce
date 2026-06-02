import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase PostgREST defaults to max ~1000 rows per request. Facet dropdowns need every
 * distinct value — paginate by stable `id` order instead of a single uncapped select.
 */
export const PIM_FACETS_PAGE_CHUNK = 1000;
export const PIM_FACETS_MAX_SCAN_ROWS = 500_000;

export type PimCatalogFacetsPayload = {
  brands: string[];
  statuses: string[];
  match_sources: string[];
  source_report_types: string[];
};

async function paginateDistinctProductColumn(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  column: "brand" | "status",
): Promise<{ values: Set<string>; error?: string; rows_scanned: number }> {
  const values = new Set<string>();
  let rowsScanned = 0;

  for (let from = 0; from < PIM_FACETS_MAX_SCAN_ROWS; from += PIM_FACETS_PAGE_CHUNK) {
    const { data, error } = await client
      .from("products")
      .select(`id, ${column}`)
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .not(column, "is", null)
      .order("id", { ascending: true })
      .range(from, from + PIM_FACETS_PAGE_CHUNK - 1);

    if (error) return { values, error: error.message, rows_scanned: rowsScanned };

    const rows = data ?? [];
    rowsScanned += rows.length;
    for (const r of rows) {
      const v = String((r as Record<string, unknown>)[column] ?? "").trim();
      if (v) values.add(v);
    }
    if (rows.length < PIM_FACETS_PAGE_CHUNK) break;
  }

  return { values, rows_scanned: rowsScanned };
}

async function paginateDistinctMapColumn(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  column: "match_source" | "source_report_type",
): Promise<{ values: Set<string>; error?: string; rows_scanned: number }> {
  const values = new Set<string>();
  let rowsScanned = 0;

  for (let from = 0; from < PIM_FACETS_MAX_SCAN_ROWS; from += PIM_FACETS_PAGE_CHUNK) {
    const { data, error } = await client
      .from("product_identifier_map")
      .select(`id, ${column}`)
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .not(column, "is", null)
      .order("id", { ascending: true })
      .range(from, from + PIM_FACETS_PAGE_CHUNK - 1);

    if (error) return { values, error: error.message, rows_scanned: rowsScanned };

    const rows = data ?? [];
    rowsScanned += rows.length;
    for (const r of rows) {
      const v = String((r as Record<string, unknown>)[column] ?? "").trim();
      if (v) values.add(v);
    }
    if (rows.length < PIM_FACETS_PAGE_CHUNK) break;
  }

  return { values, rows_scanned: rowsScanned };
}

export type CollectPimCatalogFacetsResult =
  | { ok: true; facets: PimCatalogFacetsPayload; meta: { brands_rows_scanned: number; statuses_rows_scanned: number; match_sources_rows_scanned: number; source_report_types_rows_scanned: number } }
  | { ok: false; error: string };

/** Complete facet read for one org + store (paginated — not limited to PostgREST default page size). */
export async function collectPimCatalogFacets(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<CollectPimCatalogFacetsResult> {
  const brands = await paginateDistinctProductColumn(client, organizationId, storeId, "brand");
  if (brands.error) return { ok: false, error: brands.error };

  const statuses = await paginateDistinctProductColumn(client, organizationId, storeId, "status");
  if (statuses.error) return { ok: false, error: statuses.error };

  const matchSources = await paginateDistinctMapColumn(client, organizationId, storeId, "match_source");
  if (matchSources.error) return { ok: false, error: matchSources.error };

  const reportTypes = await paginateDistinctMapColumn(client, organizationId, storeId, "source_report_type");
  if (reportTypes.error) return { ok: false, error: reportTypes.error };

  const sort = (a: string, b: string) => a.localeCompare(b);

  return {
    ok: true,
    facets: {
      brands: [...brands.values].sort(sort),
      statuses: [...statuses.values].sort(sort),
      match_sources: [...matchSources.values].sort(sort),
      source_report_types: [...reportTypes.values].sort(sort),
    },
    meta: {
      brands_rows_scanned: brands.rows_scanned,
      statuses_rows_scanned: statuses.rows_scanned,
      match_sources_rows_scanned: matchSources.rows_scanned,
      source_report_types_rows_scanned: reportTypes.rows_scanned,
    },
  };
}
