/**
 * PHASE-CLAIM-LATEST-SALE-NET-SOURCE-COVERAGE-BACKFILL-V1 — deterministic resolver.
 *
 * Resolves the latest valid SALE (and the Amazon fees tied to that same sale row)
 * for a SKU at/before a claim event date, deterministically. This is the single
 * source of truth for `latest_sold_price` + `amazon_fees_total` feeding the
 * latest-sale-net claim amount, replacing the old "arbitrary latest row" lookup
 * that drifted run-to-run.
 *
 * Rules (must stay deterministic):
 *  - Source priority: amazon_reports_repository (Seller Central Transaction View)
 *    then amazon_settlements. Same SKU only (ASIN is null on pilot rows).
 *  - Only real sales: transaction_type = 'Order' AND product_sales > 0.
 *    Refunds / reimbursements / reversals / fee-only / $0 adjustments are excluded.
 *  - Only rows at/before end-of-day of the claim event date.
 *  - Latest by sale date, tie-broken by id DESC → one stable winner.
 *  - Amazon fees come from the SAME selected sale row (|selling_fees|+|fba_fees|+|other|).
 *  - No settlement-net fallback, no COGS fallback, no scanner/OCR values.
 *  - If no valid sale, returns found=false with an explicit unknown_reason.
 *
 * Read-only. NEVER mutates claim_* tables or calls Amazon.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const LATEST_SALE_NET_RESOLVER_V1 = "latest-sale-net-resolver-v1" as const;

/** Where the governed deterministic backfill cache lives. */
export const LATEST_SALE_NET_CACHE_LOCATION =
  "workspace_settings.module_configs.claims.latest_sale_net_cache" as const;

export type SaleMatchConfidence = "high" | "medium" | "none";
export type FeeSourceConfidence = "high" | "unknown";

export type LatestSaleNetResolution = {
  found: boolean;
  latest_sold_price: number | null;
  latest_sold_price_source: string | null;
  latest_sold_price_source_row_id: string | null;
  sale_event_date: string | null;
  amazon_fees_total: number | null;
  amazon_fees_source: string | null;
  fee_source_confidence: FeeSourceConfidence;
  fee_components: { selling_fees: number | null; fba_fees: number | null; other_fees: number | null } | null;
  sale_match_confidence: SaleMatchConfidence;
  deterministic: boolean;
  match_reason: string;
  unknown_reason: string | null;
  alternates: Array<{ source: string; sale_date: string; product_sales: number | null }>;
};

export type CachedLatestSaleNetEntry = LatestSaleNetResolution & {
  claim_submission_id: string;
  sku: string | null;
  resolved_at: string;
  resolver_version: typeof LATEST_SALE_NET_RESOLVER_V1;
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function endOfDayIso(eventDate: string | null): string {
  const day = str(eventDate).slice(0, 10);
  if (!day) return "2999-12-31T23:59:59.999+00:00";
  return `${day}T23:59:59.999+00:00`;
}

function feesFromRow(row: Record<string, unknown>): {
  total: number | null;
  confidence: FeeSourceConfidence;
  components: { selling_fees: number | null; fba_fees: number | null; other_fees: number | null };
} {
  const selling = num(row.selling_fees);
  const fba = num(row.fba_fees);
  const other = num(row.other_transaction_fees);
  const parts = [selling, fba, other].filter((v): v is number => v != null);
  const components = {
    selling_fees: selling == null ? null : Math.abs(selling),
    fba_fees: fba == null ? null : Math.abs(fba),
    other_fees: other == null ? null : Math.abs(other),
  };
  if (parts.length === 0) return { total: null, confidence: "unknown", components };
  const total = parts.reduce((a, b) => a + Math.abs(b), 0);
  return { total, confidence: "high", components };
}

const SALE_SELECT =
  "id, sku, transaction_type, product_sales, selling_fees, fba_fees, other_transaction_fees, quantity, order_id";

async function latestOrderSale(
  client: SupabaseClient,
  table: string,
  dateCol: string,
  args: { organizationId: string; storeId: string; sku: string; beforeIso: string; storeScoped: boolean },
): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  let q = client
    .from(table)
    .select(`${SALE_SELECT}, ${dateCol}`)
    .eq("organization_id", args.organizationId)
    .eq("sku", args.sku)
    .eq("transaction_type", "Order")
    .gt("product_sales", 0)
    .lte(dateCol, args.beforeIso)
    .order(dateCol, { ascending: false })
    .order("id", { ascending: false })
    .limit(6);
  if (args.storeScoped) q = q.eq("store_id", args.storeId);
  const { data, error } = await q;
  if (error) {
    if (
      error.message.includes("does not exist") ||
      error.message.includes("schema cache") ||
      error.message.includes("timeout")
    ) {
      return { rows: [], error: null };
    }
    return { rows: [], error: `${table}: ${error.message}` };
  }
  return { rows: (data ?? []) as unknown as Record<string, unknown>[], error: null };
}

function unknownResolution(reason: string): LatestSaleNetResolution {
  return {
    found: false,
    latest_sold_price: null,
    latest_sold_price_source: null,
    latest_sold_price_source_row_id: null,
    sale_event_date: null,
    amazon_fees_total: null,
    amazon_fees_source: null,
    fee_source_confidence: "unknown",
    fee_components: null,
    sale_match_confidence: "none",
    deterministic: true,
    match_reason: reason,
    unknown_reason: reason,
    alternates: [],
  };
}

/**
 * Deterministically resolve the latest valid sale + tied Amazon fees for a SKU
 * at/before the claim event date. Pure read; no writes.
 */
export async function resolveLatestSaleNetDeterministic(
  client: SupabaseClient,
  args: { organizationId: string; storeId: string; sku: string | null; eventDate: string | null },
): Promise<LatestSaleNetResolution> {
  const sku = str(args.sku);
  if (!sku) return unknownResolution("NO_SKU_FOR_CLAIM");

  const beforeIso = endOfDayIso(args.eventDate);

  const repo = await latestOrderSale(client, "amazon_reports_repository", "date_time", {
    organizationId: args.organizationId,
    storeId: args.storeId,
    sku,
    beforeIso,
    storeScoped: false,
  });
  const settlement = await latestOrderSale(client, "amazon_settlements", "posted_date", {
    organizationId: args.organizationId,
    storeId: args.storeId,
    sku,
    beforeIso,
    storeScoped: true,
  });

  type Candidate = {
    row: Record<string, unknown>;
    source: string;
    dateCol: string;
    date: string;
    confidence: SaleMatchConfidence;
  };
  const candidates: Candidate[] = [];
  for (const r of repo.rows) {
    candidates.push({
      row: r,
      source: "amazon_reports_repository.product_sales",
      dateCol: "date_time",
      date: str(r.date_time),
      confidence: "high",
    });
  }
  for (const r of settlement.rows) {
    candidates.push({
      row: r,
      source: "amazon_settlements.product_sales",
      dateCol: "posted_date",
      date: str(r.posted_date),
      confidence: "medium",
    });
  }

  if (candidates.length === 0) {
    return unknownResolution("NO_VALID_ORDER_SALE_AT_OR_BEFORE_EVENT");
  }

  // Deterministic winner: source priority (repo before settlement) is already encoded
  // by insertion order; within a source rows are sale-date DESC, id DESC. Pick the
  // highest-priority source's latest row.
  const winner = candidates[0]!;
  const price = num(winner.row.product_sales);
  const fees = feesFromRow(winner.row);

  const alternates = candidates
    .slice(1)
    .slice(0, 4)
    .map((c) => ({ source: c.source, sale_date: c.date, product_sales: num(c.row.product_sales) }));

  return {
    found: true,
    latest_sold_price: price,
    latest_sold_price_source: winner.source,
    latest_sold_price_source_row_id: str(winner.row.id) || null,
    sale_event_date: winner.date || null,
    amazon_fees_total: fees.total,
    amazon_fees_source: fees.total != null ? `${winner.source.split(".")[0]}.selling_fees+fba_fees` : null,
    fee_source_confidence: fees.confidence,
    fee_components: fees.components,
    sale_match_confidence: winner.confidence,
    deterministic: true,
    match_reason: `latest Order sale (product_sales>0) for SKU at/before event from ${winner.source}; fees tied to same row`,
    unknown_reason: null,
    alternates,
  };
}

type CanonicalRow = { id: string; module_configs: Record<string, unknown> };

async function resolveCanonicalRow(client: SupabaseClient, organizationId: string): Promise<CanonicalRow | null> {
  const byOrg = await client
    .from("workspace_settings")
    .select("id, module_configs")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!byOrg.error && byOrg.data) {
    return {
      id: String((byOrg.data as { id: unknown }).id),
      module_configs: metaRecord((byOrg.data as { module_configs?: unknown }).module_configs),
    };
  }
  const singleton = await client
    .from("workspace_settings")
    .select("id, module_configs")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!singleton.error && singleton.data) {
    return {
      id: String((singleton.data as { id: unknown }).id),
      module_configs: metaRecord((singleton.data as { module_configs?: unknown }).module_configs),
    };
  }
  return null;
}

/** Read-only: load the governed deterministic backfill cache (submission_id → entry). */
export async function readLatestSaleNetCache(
  client: SupabaseClient,
  organizationId: string,
): Promise<Record<string, CachedLatestSaleNetEntry>> {
  const row = await resolveCanonicalRow(client, organizationId);
  if (!row) return {};
  const claims = metaRecord(row.module_configs.claims);
  const cache = metaRecord(claims.latest_sale_net_cache);
  const entries = metaRecord(cache.entries);
  const out: Record<string, CachedLatestSaleNetEntry> = {};
  for (const [key, raw] of Object.entries(entries)) {
    const e = metaRecord(raw);
    out[key] = {
      claim_submission_id: String(e.claim_submission_id ?? key),
      sku: e.sku == null ? null : String(e.sku),
      found: e.found === true,
      latest_sold_price: num(e.latest_sold_price),
      latest_sold_price_source: e.latest_sold_price_source == null ? null : String(e.latest_sold_price_source),
      latest_sold_price_source_row_id:
        e.latest_sold_price_source_row_id == null ? null : String(e.latest_sold_price_source_row_id),
      sale_event_date: e.sale_event_date == null ? null : String(e.sale_event_date),
      amazon_fees_total: num(e.amazon_fees_total),
      amazon_fees_source: e.amazon_fees_source == null ? null : String(e.amazon_fees_source),
      fee_source_confidence: (String(e.fee_source_confidence ?? "unknown") as FeeSourceConfidence),
      fee_components: (() => {
        const fc = metaRecord(e.fee_components);
        if (Object.keys(fc).length === 0) return null;
        return {
          selling_fees: num(fc.selling_fees),
          fba_fees: num(fc.fba_fees),
          other_fees: num(fc.other_fees),
        };
      })(),
      sale_match_confidence: (String(e.sale_match_confidence ?? "none") as SaleMatchConfidence),
      deterministic: e.deterministic !== false,
      match_reason: String(e.match_reason ?? ""),
      unknown_reason: e.unknown_reason == null ? null : String(e.unknown_reason),
      alternates: Array.isArray(e.alternates)
        ? (e.alternates as unknown[]).map((a) => {
            const ar = metaRecord(a);
            return {
              source: String(ar.source ?? ""),
              sale_date: String(ar.sale_date ?? ""),
              product_sales: num(ar.product_sales),
            };
          })
        : [],
      resolved_at: String(e.resolved_at ?? ""),
      resolver_version: LATEST_SALE_NET_RESOLVER_V1,
    };
  }
  return out;
}
