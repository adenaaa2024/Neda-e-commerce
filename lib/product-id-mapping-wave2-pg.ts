/**
 * PRODUCT-ID-MAPPING-WAVE-2-V176 — staging-only exact identifier backfill via product_identifier_map.
 * Tiers: 1 FNSKU, 2 SKU+ASIN, 3 SKU, 4 ASIN, UPC (slip_contents when column present).
 * No title/OCR/fuzzy; no settlements/ledger; requires organization_id + store_id.
 */

import type pg from "pg";

export type Wave2TargetTable =
  | "amazon_returns"
  | "amazon_manage_fba_inventory"
  | "slip_contents"
  | "amazon_transactions"
  | "amazon_amazon_fulfilled_inventory";

export type Wave2Tier = 1 | 2 | 3 | 4 | "upc";

export type Wave2TableConfig = {
  table: Wave2TargetTable;
  fnskuExpr: string | null;
  skuExpr: string | null;
  asinExpr: string | null;
  upcExpr: string | null;
};

export type Wave2TierResult = {
  table: Wave2TargetTable;
  tier: Wave2Tier;
  eligible: number;
  updated: number;
};

const ALLOWED_TABLES = new Set<string>([
  "amazon_returns",
  "amazon_manage_fba_inventory",
  "slip_contents",
  "amazon_transactions",
  "amazon_amazon_fulfilled_inventory",
]);

function assertTable(table: string): asserts table is Wave2TargetTable {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`wave2 forbidden table: ${table}`);
}

export async function tableHasColumn(
  client: pg.Client,
  table: string,
  column: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function buildWave2TableConfig(client: pg.Client, table: Wave2TargetTable): Promise<Wave2TableConfig | null> {
  assertTable(table);
  const exists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  if ((exists.rowCount ?? 0) === 0) return null;

  const has = (c: string) => tableHasColumn(client, table, c);

  switch (table) {
    case "amazon_returns": {
      const hasRaw = await has("raw_data");
      const fnskuExpr =
        (await has("fnsku"))
          ? `NULLIF(TRIM(t.fnsku), '')`
          : hasRaw
            ? `NULLIF(TRIM(COALESCE(t.raw_data->>'fnsku', t.raw_data->>'FNSKU')), '')`
            : null;
      return {
        table,
        fnskuExpr,
        skuExpr: (await has("sku")) ? `NULLIF(TRIM(t.sku), '')` : null,
        asinExpr: (await has("asin")) ? `NULLIF(TRIM(t.asin), '')` : null,
        upcExpr: null,
      };
    }
    case "amazon_manage_fba_inventory":
      return {
        table,
        fnskuExpr: (await has("fnsku")) ? `NULLIF(TRIM(t.fnsku), '')` : null,
        skuExpr: (await has("sku")) ? `NULLIF(TRIM(t.sku), '')` : null,
        asinExpr: (await has("asin")) ? `NULLIF(TRIM(t.asin), '')` : null,
        upcExpr: null,
      };
    case "slip_contents":
      return {
        table,
        fnskuExpr: (await has("fnsku")) ? `NULLIF(TRIM(t.fnsku), '')` : null,
        skuExpr: (await has("sku")) ? `NULLIF(TRIM(t.sku), '')` : null,
        asinExpr: (await has("asin")) ? `NULLIF(TRIM(t.asin), '')` : null,
        upcExpr: (await has("upc")) ? `NULLIF(TRIM(t.upc), '')` : null,
      };
    case "amazon_transactions":
      return {
        table,
        fnskuExpr: null,
        skuExpr: (await has("sku")) ? `NULLIF(TRIM(t.sku), '')` : null,
        asinExpr: (await has("asin")) ? `NULLIF(TRIM(t.asin), '')` : null,
        upcExpr: null,
      };
    case "amazon_amazon_fulfilled_inventory":
      return {
        table,
        fnskuExpr: (await has("fulfillment_channel_sku"))
          ? `NULLIF(TRIM(t.fulfillment_channel_sku), '')`
          : null,
        skuExpr: (await has("seller_sku")) ? `NULLIF(TRIM(t.seller_sku), '')` : null,
        asinExpr: (await has("asin")) ? `NULLIF(TRIM(t.asin), '')` : null,
        upcExpr: null,
      };
    default:
      return null;
  }
}

function tierJoinClause(tier: Wave2Tier, cfg: Wave2TableConfig): string | null {
  switch (tier) {
    case 1:
      if (!cfg.fnskuExpr) return null;
      return `NULLIF(TRIM(m.fnsku), '') = e.fnsku_val`;
    case 2:
      if (!cfg.skuExpr || !cfg.asinExpr) return null;
      return `(
        (NULLIF(TRIM(m.seller_sku), '') = e.sku_val OR NULLIF(TRIM(m.msku), '') = e.sku_val)
        AND NULLIF(TRIM(m.asin), '') = e.asin_val
      )`;
    case 3:
      if (!cfg.skuExpr) return null;
      return `(NULLIF(TRIM(m.seller_sku), '') = e.sku_val OR NULLIF(TRIM(m.msku), '') = e.sku_val)`;
    case 4:
      if (!cfg.asinExpr) return null;
      return `NULLIF(TRIM(m.asin), '') = e.asin_val`;
    case "upc":
      if (!cfg.upcExpr) return null;
      return `NULLIF(TRIM(m.upc_code), '') = e.upc_val`;
    default:
      return null;
  }
}

function tierStatus(tier: Wave2Tier): string {
  switch (tier) {
    case 1:
      return "resolved";
    case 2:
      return "matched";
    case 3:
      return "matched";
    case 4:
      return "matched";
    case "upc":
      return "resolved";
    default:
      return "resolved";
  }
}

function tierConfidence(tier: Wave2Tier): number {
  switch (tier) {
    case 1:
      return 1;
    case 2:
      return 0.95;
    case 3:
      return 0.85;
    case 4:
      return 0.7;
    case "upc":
      return 1;
    default:
      return 0.85;
  }
}

function eligibleCte(cfg: Wave2TableConfig, tier: Wave2Tier): string | null {
  const join = tierJoinClause(tier, cfg);
  if (!join) return null;

  const parts = [
    "t.id",
    "t.organization_id",
    "t.store_id",
    cfg.fnskuExpr ? `${cfg.fnskuExpr} AS fnsku_val` : "NULL::text AS fnsku_val",
    cfg.skuExpr ? `${cfg.skuExpr} AS sku_val` : "NULL::text AS sku_val",
    cfg.asinExpr ? `${cfg.asinExpr} AS asin_val` : "NULL::text AS asin_val",
    cfg.upcExpr ? `${cfg.upcExpr} AS upc_val` : "NULL::text AS upc_val",
  ];

  let where = `t.resolved_product_id IS NULL AND t.store_id IS NOT NULL AND t.organization_id IS NOT NULL`;
  switch (tier) {
    case 1:
      where += ` AND ${cfg.fnskuExpr} IS NOT NULL`;
      break;
    case 2:
      where += ` AND ${cfg.skuExpr} IS NOT NULL AND ${cfg.asinExpr} IS NOT NULL`;
      break;
    case 3:
      where += ` AND ${cfg.skuExpr} IS NOT NULL`;
      break;
    case 4:
      where += ` AND ${cfg.asinExpr} IS NOT NULL`;
      break;
    case "upc":
      where += ` AND ${cfg.upcExpr} IS NOT NULL`;
      break;
  }

  return `
    eligible AS (
      SELECT ${parts.join(", ")}
      FROM public."${cfg.table}" t
      WHERE ${where}
    )`;
}

function keyedMapCte(tier: Wave2Tier): string | null {
  switch (tier) {
    case 1:
      return `
    keys AS (
      SELECT DISTINCT organization_id, store_id, fnsku_val
      FROM eligible
      WHERE fnsku_val IS NOT NULL
    ),
    map AS (
      SELECT m.organization_id, m.store_id, TRIM(m.fnsku) AS fnsku_val, m.product_id, m.catalog_product_id
      FROM public.product_identifier_map m
      INNER JOIN keys k
        ON k.organization_id = m.organization_id
        AND k.store_id = m.store_id
        AND NULLIF(TRIM(m.fnsku), '') = k.fnsku_val
      WHERE m.product_id IS NOT NULL
    )`;
    case 2:
      return `
    keys AS (
      SELECT DISTINCT organization_id, store_id, sku_val, asin_val
      FROM eligible
      WHERE sku_val IS NOT NULL AND asin_val IS NOT NULL
    ),
    map AS (
      SELECT m.organization_id, m.store_id,
        COALESCE(NULLIF(TRIM(m.seller_sku), ''), NULLIF(TRIM(m.msku), '')) AS sku_val,
        NULLIF(TRIM(m.asin), '') AS asin_val,
        m.product_id, m.catalog_product_id
      FROM public.product_identifier_map m
      INNER JOIN keys k
        ON k.organization_id = m.organization_id
        AND k.store_id = m.store_id
        AND NULLIF(TRIM(m.asin), '') = k.asin_val
        AND (NULLIF(TRIM(m.seller_sku), '') = k.sku_val OR NULLIF(TRIM(m.msku), '') = k.sku_val)
      WHERE m.product_id IS NOT NULL
    )`;
    case 3:
      return `
    keys AS (
      SELECT DISTINCT organization_id, store_id, sku_val
      FROM eligible
      WHERE sku_val IS NOT NULL
    ),
    map AS (
      SELECT m.organization_id, m.store_id,
        COALESCE(NULLIF(TRIM(m.seller_sku), ''), NULLIF(TRIM(m.msku), '')) AS sku_val,
        m.product_id, m.catalog_product_id
      FROM public.product_identifier_map m
      INNER JOIN keys k
        ON k.organization_id = m.organization_id
        AND k.store_id = m.store_id
        AND (NULLIF(TRIM(m.seller_sku), '') = k.sku_val OR NULLIF(TRIM(m.msku), '') = k.sku_val)
      WHERE m.product_id IS NOT NULL
    )`;
    case 4:
      return `
    keys AS (
      SELECT DISTINCT organization_id, store_id, asin_val
      FROM eligible
      WHERE asin_val IS NOT NULL
    ),
    map AS (
      SELECT m.organization_id, m.store_id, NULLIF(TRIM(m.asin), '') AS asin_val, m.product_id, m.catalog_product_id
      FROM public.product_identifier_map m
      INNER JOIN keys k
        ON k.organization_id = m.organization_id
        AND k.store_id = m.store_id
        AND NULLIF(TRIM(m.asin), '') = k.asin_val
      WHERE m.product_id IS NOT NULL
    )`;
    case "upc":
      return `
    keys AS (
      SELECT DISTINCT organization_id, store_id, upc_val
      FROM eligible
      WHERE upc_val IS NOT NULL
    ),
    map AS (
      SELECT m.organization_id, m.store_id, NULLIF(TRIM(m.upc_code), '') AS upc_val, m.product_id, m.catalog_product_id
      FROM public.product_identifier_map m
      INNER JOIN keys k
        ON k.organization_id = m.organization_id
        AND k.store_id = m.store_id
        AND NULLIF(TRIM(m.upc_code), '') = k.upc_val
      WHERE m.product_id IS NOT NULL
    )`;
    default:
      return null;
  }
}

function matchJoinOnTier(tier: Wave2Tier): string {
  switch (tier) {
    case 1:
      return `e.fnsku_val = m.fnsku_val`;
    case 2:
      return `e.sku_val = m.sku_val AND e.asin_val = m.asin_val`;
    case 3:
      return `e.sku_val = m.sku_val`;
    case 4:
      return `e.asin_val = m.asin_val`;
    case "upc":
      return `e.upc_val = m.upc_val`;
    default:
      return "false";
  }
}

export async function countWave2TierEligible(
  client: pg.Client,
  cfg: Wave2TableConfig,
  tier: Wave2Tier,
): Promise<number> {
  const eligible = eligibleCte(cfg, tier);
  const keyed = keyedMapCte(tier);
  if (!eligible || !keyed || !tierJoinClause(tier, cfg)) return 0;

  const q = `
    WITH ${eligible},
    ${keyed},
    grouped AS (
      SELECT e.id
      FROM eligible e
      JOIN map m
        ON m.organization_id = e.organization_id
        AND m.store_id = e.store_id
        AND ${matchJoinOnTier(tier)}
      GROUP BY e.id
      HAVING COUNT(DISTINCT m.product_id) = 1
    )
    SELECT COUNT(*)::bigint AS n FROM grouped
  `;
  const r = await client.query(q);
  return Number(r.rows[0]?.n ?? 0);
}

export async function executeWave2TierBackfill(
  client: pg.Client,
  cfg: Wave2TableConfig,
  tier: Wave2Tier,
  runId: string,
  auditTable: string,
): Promise<number> {
  const eligible = eligibleCte(cfg, tier);
  const keyed = keyedMapCte(tier);
  if (!eligible || !keyed || !tierJoinClause(tier, cfg)) return 0;

  const status = tierStatus(tier);
  const confidence = tierConfidence(tier);
  const matchTier = tier === "upc" ? 1 : tier;

  const q = `
    WITH ${eligible},
    ${keyed},
    winners AS (
      SELECT e.id AS row_id,
        (array_agg(m.product_id ORDER BY m.product_id))[1] AS product_id,
        (array_agg(m.catalog_product_id ORDER BY m.catalog_product_id))[1] AS catalog_product_id
      FROM eligible e
      JOIN map m
        ON m.organization_id = e.organization_id
        AND m.store_id = e.store_id
        AND ${matchJoinOnTier(tier)}
      GROUP BY e.id
      HAVING COUNT(DISTINCT m.product_id) = 1
    ),
    updated AS (
      UPDATE public."${cfg.table}" t
      SET
        resolved_product_id = w.product_id,
        resolved_catalog_product_id = w.catalog_product_id,
        identifier_resolution_status = $3,
        identifier_resolution_confidence = $4
      FROM winners w
      WHERE t.id = w.row_id
      RETURNING t.id, w.product_id, w.catalog_product_id
    )
    INSERT INTO public."${auditTable}" (
      run_id, source_table, source_row_id, match_tier,
      new_resolved_product_id, new_resolved_catalog_product_id,
      new_identifier_resolution_status, new_identifier_resolution_confidence
    )
    SELECT $1, $2, u.id, $5, u.product_id, u.catalog_product_id, $3, $4
    FROM updated u
    RETURNING id
  `;
  const res = await client.query(q, [runId, cfg.table, status, confidence, matchTier]);
  return res.rowCount ?? 0;
}

export async function probeTableCoverage(
  client: pg.Client,
  table: string,
): Promise<{
  table: string;
  total: number;
  resolved: number;
  unresolved: number;
  coverage_pct: number;
  ambiguous: number;
} | null> {
  assertTable(table);
  const exists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  if ((exists.rowCount ?? 0) === 0) return null;
  const hasStatus = await tableHasColumn(client, table, "identifier_resolution_status");
  const r = await client.query(`
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::bigint AS unresolved
      ${hasStatus ? ", COUNT(*) FILTER (WHERE identifier_resolution_status = 'ambiguous')::bigint AS ambiguous" : ", 0::bigint AS ambiguous"}
    FROM public."${table}"
  `);
  const row = r.rows[0] as { total: string; resolved: string; unresolved: string; ambiguous: string };
  const total = Number(row.total);
  const resolved = Number(row.resolved);
  return {
    table,
    total,
    resolved,
    unresolved: Number(row.unresolved),
    coverage_pct: total > 0 ? Math.round((resolved / total) * 1000) / 10 : 100,
    ambiguous: Number(row.ambiguous),
  };
}

export async function ensureWave2AuditTable(client: pg.Client, auditTable: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public."${auditTable}" (
      id bigserial PRIMARY KEY,
      run_id text NOT NULL,
      source_table text NOT NULL,
      source_row_id uuid NOT NULL,
      match_tier int NOT NULL,
      old_resolved_product_id uuid,
      new_resolved_product_id uuid,
      new_resolved_catalog_product_id uuid,
      new_identifier_resolution_status text,
      new_identifier_resolution_confidence numeric,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function assertPackageItemsForbidden(client: pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'package_items'`,
  );
  return (r.rowCount ?? 0) > 0;
}

export const WAVE2_TARGET_ORDER: Wave2TargetTable[] = [
  "amazon_returns",
  "amazon_manage_fba_inventory",
  "slip_contents",
  "amazon_transactions",
  "amazon_amazon_fulfilled_inventory",
];

export const WAVE2_TIER_ORDER: Wave2Tier[] = [1, 2, 3, 4, "upc"];

/** Conservative tiers for very large unresolved cohorts (tier-3 SKU-only is expensive). */
export const WAVE2_TIERS_BY_TABLE: Record<Wave2TargetTable, Wave2Tier[]> = {
  /** Tier 2 (SKU+ASIN) dry-run can be slow on wide cohorts — run with `--tiers=2` when needed. */
  amazon_returns: [1, 4],
  amazon_manage_fba_inventory: [1, 4],
  slip_contents: [1, 4, "upc"],
  amazon_transactions: [2],
  amazon_amazon_fulfilled_inventory: [1, 4],
};
