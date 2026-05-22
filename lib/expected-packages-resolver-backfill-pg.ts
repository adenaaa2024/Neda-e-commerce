/**
 * EXPECTED-PACKAGES-RESOLVER-BACKFILL-V180 — staging tiered backfill on expected_packages.
 * Mirrors V176 tiers; ASIN from amazon_removals via source_detail_row_id when present.
 */

import type pg from "pg";

export type ExpectedPackagesTier = 1 | 2 | 3 | 4;

export const EP_TIER_ORDER: ExpectedPackagesTier[] = [1, 2, 3, 4];

/** Tier 2 (SKU+ASIN) can be slow — run with `--tiers=2` when needed. */
export const EP_DEFAULT_TIERS: ExpectedPackagesTier[] = [1, 4];

const FROM_CLAUSE = `
  public.expected_packages t
  LEFT JOIN public.amazon_removals ar
    ON ar.id = t.source_detail_row_id
    AND ar.organization_id = t.organization_id
`;

const FNSKU_EXPR = `NULLIF(TRIM(t.fnsku), '')`;
const SKU_EXPR = `NULLIF(TRIM(t.sku), '')`;

/** Resolved at runtime — staging amazon_removals may store ASIN in raw_data only. */
let asinExprSql = `NULLIF(TRIM(COALESCE(ar.raw_data->>'asin', ar.raw_data->>'ASIN')), '')`;

export async function initExpectedPackagesAsinExpr(client: pg.Client): Promise<void> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'amazon_removals' AND column_name = 'asin'`,
  );
  asinExprSql =
    (r.rowCount ?? 0) > 0
      ? `COALESCE(NULLIF(TRIM(ar.asin), ''), NULLIF(TRIM(COALESCE(ar.raw_data->>'asin', ar.raw_data->>'ASIN')), ''))`
      : `NULLIF(TRIM(COALESCE(ar.raw_data->>'asin', ar.raw_data->>'ASIN')), '')`;
}

function asinExpr(): string {
  return asinExprSql;
}

function tierStatus(tier: ExpectedPackagesTier): string {
  return tier === 1 ? "resolved" : "matched";
}

function tierConfidence(tier: ExpectedPackagesTier): number {
  switch (tier) {
    case 1:
      return 1;
    case 2:
      return 0.95;
    case 3:
      return 0.85;
    case 4:
      return 0.7;
    default:
      return 0.85;
  }
}

function fromClauseForTier(tier: ExpectedPackagesTier): string {
  if (tier === 1 || tier === 3) {
    return `public.expected_packages t`;
  }
  return FROM_CLAUSE;
}

function eligibleCte(tier: ExpectedPackagesTier): string {
  let where = `t.resolved_product_id IS NULL AND t.store_id IS NOT NULL AND t.organization_id IS NOT NULL`;
  switch (tier) {
    case 1:
      where += ` AND ${FNSKU_EXPR} IS NOT NULL`;
      break;
    case 2:
      where += ` AND ${SKU_EXPR} IS NOT NULL AND ${asinExpr()} IS NOT NULL`;
      break;
    case 3:
      where += ` AND ${SKU_EXPR} IS NOT NULL`;
      break;
    case 4:
      where += ` AND ${asinExpr()} IS NOT NULL`;
      break;
  }
  const asinSelect = tier === 1 || tier === 3 ? `NULL::text AS asin_val` : `${asinExpr()} AS asin_val`;
  return `
    eligible AS (
      SELECT
        t.id,
        t.organization_id,
        t.store_id,
        ${FNSKU_EXPR} AS fnsku_val,
        ${SKU_EXPR} AS sku_val,
        ${asinSelect}
      FROM ${fromClauseForTier(tier)}
      WHERE ${where}
    )`;
}

function keyedMapCte(tier: ExpectedPackagesTier): string {
  switch (tier) {
    case 1:
      return `
    keys AS (
      SELECT DISTINCT organization_id, store_id, fnsku_val FROM eligible WHERE fnsku_val IS NOT NULL
    ),
    map AS (
      SELECT m.organization_id, m.store_id, TRIM(m.fnsku) AS fnsku_val, m.product_id, m.catalog_product_id
      FROM public.product_identifier_map m
      INNER JOIN keys k
        ON k.organization_id = m.organization_id AND k.store_id = m.store_id
        AND NULLIF(TRIM(m.fnsku), '') = k.fnsku_val
      WHERE m.product_id IS NOT NULL
    )`;
    case 2:
      return `
    keys AS (
      SELECT DISTINCT organization_id, store_id, sku_val, asin_val
      FROM eligible WHERE sku_val IS NOT NULL AND asin_val IS NOT NULL
    ),
    map AS (
      SELECT m.organization_id, m.store_id,
        COALESCE(NULLIF(TRIM(m.seller_sku), ''), NULLIF(TRIM(m.msku), '')) AS sku_val,
        NULLIF(TRIM(m.asin), '') AS asin_val,
        m.product_id, m.catalog_product_id
      FROM public.product_identifier_map m
      INNER JOIN keys k
        ON k.organization_id = m.organization_id AND k.store_id = m.store_id
        AND NULLIF(TRIM(m.asin), '') = k.asin_val
        AND (NULLIF(TRIM(m.seller_sku), '') = k.sku_val OR NULLIF(TRIM(m.msku), '') = k.sku_val)
      WHERE m.product_id IS NOT NULL
    )`;
    case 3:
      return `
    keys AS (
      SELECT DISTINCT organization_id, store_id, sku_val FROM eligible WHERE sku_val IS NOT NULL
    ),
    map AS (
      SELECT m.organization_id, m.store_id,
        COALESCE(NULLIF(TRIM(m.seller_sku), ''), NULLIF(TRIM(m.msku), '')) AS sku_val,
        m.product_id, m.catalog_product_id
      FROM public.product_identifier_map m
      INNER JOIN keys k
        ON k.organization_id = m.organization_id AND k.store_id = m.store_id
        AND (NULLIF(TRIM(m.seller_sku), '') = k.sku_val OR NULLIF(TRIM(m.msku), '') = k.sku_val)
      WHERE m.product_id IS NOT NULL
    )`;
    case 4:
      return `
    keys AS (
      SELECT DISTINCT organization_id, store_id, asin_val FROM eligible WHERE asin_val IS NOT NULL
    ),
    map AS (
      SELECT m.organization_id, m.store_id, NULLIF(TRIM(m.asin), '') AS asin_val, m.product_id, m.catalog_product_id
      FROM public.product_identifier_map m
      INNER JOIN keys k
        ON k.organization_id = m.organization_id AND k.store_id = m.store_id
        AND NULLIF(TRIM(m.asin), '') = k.asin_val
      WHERE m.product_id IS NOT NULL
    )`;
    default:
      return "";
  }
}

function matchJoin(tier: ExpectedPackagesTier): string {
  switch (tier) {
    case 1:
      return `e.fnsku_val = m.fnsku_val`;
    case 2:
      return `e.sku_val = m.sku_val AND e.asin_val = m.asin_val`;
    case 3:
      return `e.sku_val = m.sku_val`;
    case 4:
      return `e.asin_val = m.asin_val`;
    default:
      return "false";
  }
}

export async function countExpectedPackagesTierEligible(
  client: pg.Client,
  tier: ExpectedPackagesTier,
): Promise<number> {
  const eligible = eligibleCte(tier);
  const keyed = keyedMapCte(tier);
  if (!keyed) return 0;
  const q = `
    WITH ${eligible},
    ${keyed},
    grouped AS (
      SELECT e.id
      FROM eligible e
      JOIN map m ON m.organization_id = e.organization_id AND m.store_id = e.store_id AND ${matchJoin(tier)}
      GROUP BY e.id
      HAVING COUNT(DISTINCT m.product_id) = 1
    )
    SELECT COUNT(*)::bigint AS n FROM grouped
  `;
  const r = await client.query(q);
  return Number(r.rows[0]?.n ?? 0);
}

const BATCH_SIZE = 25;

async function executeTier4AsinDirectBatch(client: pg.Client, runId: string, auditTable: string): Promise<number> {
  const q = `
    WITH picked AS (
      SELECT t.id
      FROM public.expected_packages t
      LEFT JOIN public.amazon_removals ar
        ON ar.id = t.source_detail_row_id AND ar.organization_id = t.organization_id
      WHERE t.resolved_product_id IS NULL
        AND t.store_id IS NOT NULL
        AND t.organization_id IS NOT NULL
        AND ${asinExpr()} IS NOT NULL
      LIMIT ${BATCH_SIZE}
    ),
    winners AS (
      SELECT p.id AS row_id,
        (array_agg(m.product_id ORDER BY m.product_id))[1] AS product_id,
        (array_agg(m.catalog_product_id ORDER BY m.catalog_product_id))[1] AS catalog_product_id
      FROM picked p
      INNER JOIN public.expected_packages t ON t.id = p.id
      LEFT JOIN public.amazon_removals ar
        ON ar.id = t.source_detail_row_id AND ar.organization_id = t.organization_id
      INNER JOIN public.product_identifier_map m
        ON m.organization_id = t.organization_id
        AND m.store_id = t.store_id
        AND NULLIF(TRIM(m.asin), '') = ${asinExpr()}
      WHERE m.product_id IS NOT NULL
      GROUP BY p.id
      HAVING COUNT(DISTINCT m.product_id) = 1
    ),
    updated AS (
      UPDATE public.expected_packages t
      SET
        resolved_product_id = w.product_id,
        resolved_catalog_product_id = w.catalog_product_id,
        identifier_resolution_status = 'matched',
        identifier_resolution_confidence = 0.7
      FROM winners w
      WHERE t.id = w.row_id
      RETURNING t.id, w.product_id, w.catalog_product_id
    )
    INSERT INTO public."${auditTable}" (
      run_id, source_table, source_row_id, match_tier,
      new_resolved_product_id, new_resolved_catalog_product_id,
      new_identifier_resolution_status, new_identifier_resolution_confidence
    )
    SELECT $1, $2, u.id, 4, u.product_id, u.catalog_product_id, 'matched', 0.7
    FROM updated u
    RETURNING id
  `;
  const res = await client.query(q, [runId, "expected_packages"]);
  return res.rowCount ?? 0;
}

async function executeTier3SkuDirectBatch(client: pg.Client, runId: string, auditTable: string): Promise<number> {
  const q = `
    WITH picked AS (
      SELECT t.id
      FROM public.expected_packages t
      WHERE t.resolved_product_id IS NULL
        AND t.store_id IS NOT NULL
        AND t.organization_id IS NOT NULL
        AND NULLIF(TRIM(t.sku), '') IS NOT NULL
      LIMIT ${BATCH_SIZE}
    ),
    winners AS (
      SELECT p.id AS row_id,
        (array_agg(m.product_id ORDER BY m.product_id))[1] AS product_id,
        (array_agg(m.catalog_product_id ORDER BY m.catalog_product_id))[1] AS catalog_product_id
      FROM picked p
      INNER JOIN public.expected_packages t ON t.id = p.id
      INNER JOIN public.product_identifier_map m
        ON m.organization_id = t.organization_id
        AND m.store_id = t.store_id
        AND (NULLIF(TRIM(m.seller_sku), '') = NULLIF(TRIM(t.sku), '')
          OR NULLIF(TRIM(m.msku), '') = NULLIF(TRIM(t.sku), ''))
      WHERE m.product_id IS NOT NULL
      GROUP BY p.id
      HAVING COUNT(DISTINCT m.product_id) = 1
    ),
    updated AS (
      UPDATE public.expected_packages t
      SET
        resolved_product_id = w.product_id,
        resolved_catalog_product_id = w.catalog_product_id,
        identifier_resolution_status = 'matched',
        identifier_resolution_confidence = 0.85
      FROM winners w
      WHERE t.id = w.row_id
      RETURNING t.id, w.product_id, w.catalog_product_id
    )
    INSERT INTO public."${auditTable}" (
      run_id, source_table, source_row_id, match_tier,
      new_resolved_product_id, new_resolved_catalog_product_id,
      new_identifier_resolution_status, new_identifier_resolution_confidence
    )
    SELECT $1, $2, u.id, 3, u.product_id, u.catalog_product_id, 'matched', 0.85
    FROM updated u
    RETURNING id
  `;
  const res = await client.query(q, [runId, "expected_packages"]);
  return res.rowCount ?? 0;
}

async function executeTier1FnskuDirectBatch(client: pg.Client, runId: string, auditTable: string): Promise<number> {
  const q = `
    WITH picked AS (
      SELECT t.id
      FROM public.expected_packages t
      WHERE t.resolved_product_id IS NULL
        AND t.store_id IS NOT NULL
        AND t.organization_id IS NOT NULL
        AND NULLIF(TRIM(t.fnsku), '') IS NOT NULL
      LIMIT ${BATCH_SIZE}
    ),
    winners AS (
      SELECT p.id AS row_id,
        (array_agg(m.product_id ORDER BY m.product_id))[1] AS product_id,
        (array_agg(m.catalog_product_id ORDER BY m.catalog_product_id))[1] AS catalog_product_id
      FROM picked p
      INNER JOIN public.expected_packages t ON t.id = p.id
      INNER JOIN public.product_identifier_map m
        ON m.organization_id = t.organization_id
        AND m.store_id = t.store_id
        AND NULLIF(TRIM(m.fnsku), '') = NULLIF(TRIM(t.fnsku), '')
      WHERE m.product_id IS NOT NULL
      GROUP BY p.id
      HAVING COUNT(DISTINCT m.product_id) = 1
    ),
    updated AS (
      UPDATE public.expected_packages t
      SET
        resolved_product_id = w.product_id,
        resolved_catalog_product_id = w.catalog_product_id,
        identifier_resolution_status = 'resolved',
        identifier_resolution_confidence = 1
      FROM winners w
      WHERE t.id = w.row_id
      RETURNING t.id, w.product_id, w.catalog_product_id
    )
    INSERT INTO public."${auditTable}" (
      run_id, source_table, source_row_id, match_tier,
      new_resolved_product_id, new_resolved_catalog_product_id,
      new_identifier_resolution_status, new_identifier_resolution_confidence
    )
    SELECT $1, $2, u.id, 1, u.product_id, u.catalog_product_id, 'resolved', 1
    FROM updated u
    RETURNING id
  `;
  const res = await client.query(q, [runId, "expected_packages"]);
  return res.rowCount ?? 0;
}

async function executeExpectedPackagesTierBackfillBatch(
  client: pg.Client,
  tier: ExpectedPackagesTier,
  runId: string,
  auditTable: string,
): Promise<number> {
  const eligible = eligibleCte(tier);
  const keyed = keyedMapCte(tier);
  const status = tierStatus(tier);
  const confidence = tierConfidence(tier);

  const q = `
    WITH ${eligible},
    ${keyed},
    winners AS (
      SELECT e.id AS row_id,
        (array_agg(m.product_id ORDER BY m.product_id))[1] AS product_id,
        (array_agg(m.catalog_product_id ORDER BY m.catalog_product_id))[1] AS catalog_product_id
      FROM eligible e
      JOIN map m ON m.organization_id = e.organization_id AND m.store_id = e.store_id AND ${matchJoin(tier)}
      GROUP BY e.id
      HAVING COUNT(DISTINCT m.product_id) = 1
      LIMIT ${BATCH_SIZE}
    ),
    updated AS (
      UPDATE public.expected_packages t
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
  const res = await client.query(q, [runId, "expected_packages", status, confidence, tier]);
  return res.rowCount ?? 0;
}

export async function executeExpectedPackagesTierBackfill(
  client: pg.Client,
  tier: ExpectedPackagesTier,
  runId: string,
  auditTable: string,
): Promise<number> {
  let total = 0;
  const batchFn =
    tier === 1
      ? () => executeTier1FnskuDirectBatch(client, runId, auditTable)
      : tier === 3
        ? () => executeTier3SkuDirectBatch(client, runId, auditTable)
        : tier === 4
          ? () => executeTier4AsinDirectBatch(client, runId, auditTable)
          : () => executeExpectedPackagesTierBackfillBatch(client, tier, runId, auditTable);
  for (let i = 0; i < 500; i++) {
    const n = await batchFn();
    total += n;
    if (n === 0) break;
  }
  return total;
}

export async function probeExpectedPackagesCoverage(client: pg.Client): Promise<{
  total: number;
  resolved: number;
  unresolved: number;
  coverage_pct: number;
  ambiguous: number;
} | null> {
  const exists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'expected_packages'`,
  );
  if ((exists.rowCount ?? 0) === 0) return null;

  const hasResolved = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'expected_packages' AND column_name = 'resolved_product_id'`,
  );
  if ((hasResolved.rowCount ?? 0) === 0) {
    const totalOnly = await client.query(`SELECT COUNT(*)::bigint AS total FROM public.expected_packages`);
    const total = Number(totalOnly.rows[0]?.total ?? 0);
    return { total, resolved: 0, unresolved: total, coverage_pct: 0, ambiguous: 0 };
  }

  const hasStatus = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'expected_packages' AND column_name = 'identifier_resolution_status'`,
  );
  const r = await client.query(`
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::bigint AS unresolved
      ${
        (hasStatus.rowCount ?? 0) > 0
          ? ", COUNT(*) FILTER (WHERE identifier_resolution_status = 'ambiguous')::bigint AS ambiguous"
          : ", 0::bigint AS ambiguous"
      }
    FROM public.expected_packages
  `);
  const row = r.rows[0] as { total: string; resolved: string; unresolved: string; ambiguous: string };
  const total = Number(row.total);
  const resolved = Number(row.resolved);
  return {
    total,
    resolved,
    unresolved: Number(row.unresolved),
    coverage_pct: total > 0 ? Math.round((resolved / total) * 1000) / 10 : 100,
    ambiguous: Number(row.ambiguous),
  };
}

export async function expectedPackagesResolverColumnsPresent(
  client: pg.Client,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'expected_packages' AND column_name = 'resolved_product_id'`,
  );
  return (r.rowCount ?? 0) > 0;
}

export async function applyExpectedPackagesResolverDdl(client: pg.Client): Promise<boolean> {
  if (await expectedPackagesResolverColumnsPresent(client)) {
    return false;
  }
  await client.query(`
    ALTER TABLE public.expected_packages
      ADD COLUMN IF NOT EXISTS resolved_product_id uuid,
      ADD COLUMN IF NOT EXISTS resolved_catalog_product_id uuid,
      ADD COLUMN IF NOT EXISTS identifier_resolution_status text,
      ADD COLUMN IF NOT EXISTS identifier_resolution_confidence numeric(10, 4)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_expected_packages_org_resolved
      ON public.expected_packages (organization_id, resolved_product_id)
      WHERE resolved_product_id IS NOT NULL
  `);
  return true;
}

export async function ensureExpectedPackagesAuditTable(client: pg.Client, auditTable: string): Promise<void> {
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
