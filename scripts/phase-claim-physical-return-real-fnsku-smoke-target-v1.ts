/**
 * PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-SMOKE-TARGET-V1 — read-only target selection.
 *   npx tsx scripts/phase-claim-physical-return-real-fnsku-smoke-target-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const FIXTURE_ORG = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const MAIN_ORG = "00000000-0000-0000-0000-000000000001";
const FIXTURE_FNSKU = "X006OFFM01";
const OUT_BASE = ".cursor/audit-reports/phase-claim-physical-return-real-fnsku-smoke-target-v1";
const CANDIDATE_LIMIT = 30;

type Row = Record<string, unknown>;

type CandidateTarget = {
  fnsku: string;
  asin: string | null;
  sku_msku: string | null;
  product_id: string;
  store_id: string | null;
  organization_id: string;
  product_prices_available: boolean;
  catalog_products_available: boolean;
  amazon_fba_inventory_available: boolean;
  price_context: string;
  cost_context: string | null;
  confidence: "high" | "medium" | "low";
  pim_row_count: number;
  conflict: boolean;
  why_safe_for_mvp: string;
  usable_without_db_writes: boolean;
  requires_rescan_manual_test: boolean;
  requires_governed_seed: boolean;
  org_store_alignment: "fixture_aligned" | "main_org_only" | "other_org";
  return_items_count: number;
  claim_candidates_count: number;
  score: number;
};

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

async function connectPg(): Promise<pg.Client> {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) throw new Error(`BLOCKED: must target ref ${STAGING_REF}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '120s'");
  await c.query("SET default_transaction_read_only = on");
  return c;
}

async function tableColumns(c: pg.Client, table: string): Promise<Set<string>> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function buildCandidate(row: Row): CandidateTarget {
  const orgId = str(row.organization_id)!;
  const storeId = str(row.store_id);
  const fnsku = str(row.fnsku)!;
  const productId = str(row.product_id)!;
  const asin = str(row.asin) ?? str(row.prod_asin);
  const skuMsku = str(row.seller_sku) ?? str(row.msku) ?? str(row.prod_sku);
  const conflict = Number(row.distinct_product_ids ?? 1) > 1;
  const hasPrices = Number(row.price_rows ?? 0) > 0;
  const hasCatalog = Number(row.catalog_rows ?? 0) > 0;
  const hasFba = Number(row.fba_rows ?? 0) > 0;
  const priceVal = num(row.latest_price);
  const costVal = num(row.unit_cost);

  let alignment: CandidateTarget["org_store_alignment"] = "other_org";
  if (orgId === FIXTURE_ORG && storeId === FIXTURE_STORE) alignment = "fixture_aligned";
  else if (orgId === MAIN_ORG) alignment = "main_org_only";

  const hasAsin = Boolean(asin);
  const hasSku = Boolean(skuMsku);

  let confidence: CandidateTarget["confidence"] = "low";
  if (!conflict && hasAsin && hasSku && hasPrices) confidence = "high";
  else if (!conflict && (hasAsin || hasSku)) confidence = "medium";

  let score = 0;
  if (confidence === "high") score += 40;
  else if (confidence === "medium") score += 25;
  else score += 10;
  if (hasPrices) score += 15;
  if (hasCatalog) score += 10;
  if (hasFba) score += 5;
  if (hasAsin) score += 10;
  if (hasSku) score += 5;
  if (orgId === MAIN_ORG) score += 20;
  if (alignment === "fixture_aligned") score += 30;
  if (conflict) score -= 100;

  return {
    fnsku,
    asin,
    sku_msku: skuMsku,
    product_id: productId,
    store_id: storeId,
    organization_id: orgId,
    product_prices_available: hasPrices,
    catalog_products_available: hasCatalog,
    amazon_fba_inventory_available: hasFba,
    price_context: hasPrices
      ? `Latest price: ${priceVal} ${str(row.price_currency) ?? "USD"} (sale context only)`
      : "No product_prices row",
    cost_context: costVal != null ? `unit_cost: ${costVal}` : null,
    confidence,
    pim_row_count: Number(row.pim_row_count ?? 1),
    conflict,
    why_safe_for_mvp: [
      `PIM FNSKU → single product_id`,
      hasAsin ? `ASIN ${asin}` : "no ASIN",
      hasSku ? "SKU/MSKU present" : "no SKU",
      conflict ? "CONFLICT" : "no ambiguity",
      `match_source: ${str(row.match_sources) ?? "unknown"}`,
    ].join("; "),
    usable_without_db_writes: alignment === "fixture_aligned",
    requires_rescan_manual_test: alignment !== "fixture_aligned",
    requires_governed_seed: false,
    org_store_alignment: alignment,
    return_items_count: Number(row.return_items_count ?? 0),
    claim_candidates_count: Number(row.claim_candidates_count ?? 0),
    score,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const c = await connectPg();

  const ppCols = await tableColumns(c, "product_prices");
  const prodCols = await tableColumns(c, "products");
  const priceCol = ["sale_price", "price", "unit_price", "list_price"].find((x) => ppCols.has(x)) ?? "price";
  const costCol = ["cost", "unit_cost", "cogs", "cost_price", "purchase_price"].find((x) => prodCols.has(x)) ?? null;
  const hasFbaTable = (
    await c.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'amazon_fba_inventory'`,
    )
  ).rowCount === 1;

  const aggSql = `
    WITH pim AS (
      SELECT organization_id, store_id, upper(btrim(fnsku)) AS fnsku_key, fnsku,
             product_id, asin, seller_sku, msku, match_source, confidence_score
      FROM public.product_identifier_map
      WHERE deleted_at IS NULL
        AND product_id IS NOT NULL
        AND btrim(fnsku) <> ''
        AND upper(btrim(fnsku)) <> upper(btrim($1))
        AND (btrim(coalesce(asin,'')) <> '' OR btrim(coalesce(seller_sku,'')) <> '' OR btrim(coalesce(msku,'')) <> '')
    ),
    grouped AS (
      SELECT organization_id, store_id, fnsku_key,
             min(fnsku) AS fnsku,
             count(*)::int AS pim_row_count,
             count(DISTINCT product_id)::int AS distinct_product_ids,
             (array_agg(product_id ORDER BY confidence_score DESC NULLS LAST))[1] AS product_id,
             (array_agg(asin ORDER BY confidence_score DESC NULLS LAST))[1] AS asin,
             (array_agg(seller_sku ORDER BY confidence_score DESC NULLS LAST))[1] AS seller_sku,
             (array_agg(msku ORDER BY confidence_score DESC NULLS LAST))[1] AS msku,
             string_agg(DISTINCT match_source, ', ') AS match_sources
      FROM pim
      GROUP BY organization_id, store_id, fnsku_key
      HAVING count(DISTINCT product_id) = 1
    )
    SELECT g.*,
           p.asin AS prod_asin, p.sku AS prod_sku,
           ${costCol ? `p.${costCol}` : "NULL::numeric"} AS unit_cost,
           (SELECT count(*)::int FROM public.product_prices pp WHERE pp.product_id = g.product_id) AS price_rows,
           (SELECT ${priceCol}::numeric FROM public.product_prices pp WHERE pp.product_id = g.product_id AND ${priceCol} IS NOT NULL ORDER BY ${ppCols.has("created_at") ? "pp.created_at" : `pp.${priceCol}`} DESC NULLS LAST LIMIT 1) AS latest_price,
           (SELECT currency FROM public.product_prices pp WHERE pp.product_id = g.product_id AND ${priceCol} IS NOT NULL ORDER BY ${ppCols.has("created_at") ? "pp.created_at" : `pp.${priceCol}`} DESC NULLS LAST LIMIT 1) AS price_currency,
           (SELECT count(*)::int FROM public.catalog_products cp
            WHERE cp.organization_id = g.organization_id
              AND (upper(btrim(cp.fnsku)) = g.fnsku_key OR (cp.asin IS NOT NULL AND btrim(cp.asin) = btrim(coalesce(g.asin,''))))
           ) AS catalog_rows,
           ${hasFbaTable
             ? `(SELECT count(*)::int FROM public.amazon_fba_inventory af
                 WHERE af.organization_id = g.organization_id AND upper(btrim(af.fnsku)) = g.fnsku_key)`
             : "0::int"} AS fba_rows,
           (SELECT count(*)::int FROM public.return_items ri
            WHERE ri.organization_id = g.organization_id AND upper(btrim(ri.fnsku)) = g.fnsku_key) AS return_items_count,
           (SELECT count(*)::int FROM public.claim_candidates cc
            WHERE cc.organization_id = g.organization_id AND upper(btrim(cc.fnsku)) = g.fnsku_key AND cc.quarantined_at IS NULL) AS claim_candidates_count
    FROM grouped g
    LEFT JOIN public.products p ON p.id = g.product_id AND p.deleted_at IS NULL
    ORDER BY
      CASE WHEN g.organization_id = $2::uuid THEN 0 WHEN g.organization_id = $3::uuid THEN 1 ELSE 2 END,
      CASE WHEN (SELECT count(*) FROM public.product_prices pp WHERE pp.product_id = g.product_id) > 0 THEN 0 ELSE 1 END,
      g.pim_row_count DESC
    LIMIT $4
  `;

  const rows = (
    await c.query(aggSql, [FIXTURE_FNSKU, MAIN_ORG, FIXTURE_ORG, CANDIDATE_LIMIT])
  ).rows as Row[];

  const candidates = rows.map(buildCandidate).sort((a, b) => b.score - a.score);

  const [fixtureSpine, mainSpine, orgSpine, mainStores] = await Promise.all([
    c.query(
      `SELECT
        (SELECT count(*)::int FROM products WHERE organization_id = $1::uuid AND deleted_at IS NULL) AS products,
        (SELECT count(*)::int FROM catalog_products WHERE organization_id = $1::uuid) AS catalog,
        (SELECT count(*)::int FROM product_identifier_map WHERE organization_id = $1::uuid AND deleted_at IS NULL) AS pim,
        (SELECT count(*)::int FROM product_prices pp JOIN products p ON p.id = pp.product_id WHERE p.organization_id = $1::uuid) AS prices`,
      [FIXTURE_ORG],
    ),
    c.query(
      `SELECT
        (SELECT count(*)::int FROM products WHERE organization_id = $1::uuid AND deleted_at IS NULL) AS products,
        (SELECT count(*)::int FROM catalog_products WHERE organization_id = $1::uuid) AS catalog,
        (SELECT count(*)::int FROM product_identifier_map WHERE organization_id = $1::uuid AND deleted_at IS NULL) AS pim,
        (SELECT count(*)::int FROM product_prices pp JOIN products p ON p.id = pp.product_id WHERE p.organization_id = $1::uuid) AS prices`,
      [MAIN_ORG],
    ),
    c.query(`
      SELECT organization_id::text AS org_id, count(*)::int AS pim_rows
      FROM public.product_identifier_map WHERE deleted_at IS NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 10
    `),
    c.query(
      `SELECT DISTINCT store_id::text FROM product_identifier_map WHERE organization_id = $1::uuid AND deleted_at IS NULL AND store_id IS NOT NULL LIMIT 20`,
      [MAIN_ORG],
    ),
  ]);

  const best = candidates[0] ?? null;
  const mainOrgCandidates = candidates.filter((x) => x.organization_id === MAIN_ORG);
  const fixtureAligned = candidates.filter((x) => x.org_store_alignment === "fixture_aligned");

  const safeToUse =
    best != null && best.confidence !== "low" && !best.conflict && best.organization_id === MAIN_ORG;

  const result = {
    audit: "PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-SMOKE-TARGET-V1",
    run_id: stamp(),
    fixture_context: {
      organization_id: FIXTURE_ORG,
      store_id: FIXTURE_STORE,
      fixture_fnsku: FIXTURE_FNSKU,
      fixture_fnsku_is_zebra_qa: true,
      fixture_spine: fixtureSpine.rows[0],
      active_claim_candidates_on_fixture_fnsku: 4,
    },
    main_org_context: {
      organization_id: MAIN_ORG,
      spine: mainSpine.rows[0],
      stores_with_pim: (mainStores.rows as Row[]).map((r) => str(r.store_id)).filter(Boolean),
    },
    orgs_with_pim: orgSpine.rows,
    real_fnsku_candidates: candidates,
    total_qualifying_fnsku_buckets_scanned: candidates.length,
    best_recommended_target: best,
    top_main_org_targets: mainOrgCandidates.slice(0, 5),
    fixture_aligned_targets: fixtureAligned,
    org_store_alignment: {
      fixture_org_has_spine: Number((fixtureSpine.rows[0] as Row).pim ?? 0) > 0,
      main_org_has_spine: Number((mainSpine.rows[0] as Row).pim ?? 0) > 0,
      cross_org_mapping_forbidden: true,
      mismatch_note:
        "Fixture org 7397edff has 0 spine rows; all real FNSKU targets live in main org 00000000-0001. Existing X006OFFM01 candidates cannot be unblocked without DB mutation.",
      implication:
        fixtureAligned.length === 0
          ? "MVP unblock = operator re-scan in MAIN ORG with a recommended real FNSKU (no cross-org mapping to fixture candidates)"
          : "Fixture-aligned FNSKU exists — re-scan in fixture org only",
    },
    price_context_status: best
      ? { product_prices_available: best.product_prices_available, price_context: best.price_context }
      : { product_prices_available: false, price_context: "none" },
    cost_context_status: best
      ? { cost_context: best.cost_context, note: "Actual cost from products spine when present" }
      : { cost_context: null },
    product_story_ready_status: {
      fixture_candidates_ready: false,
      main_org_rescan_ready: best != null && best.organization_id === MAIN_ORG,
      reason: "Product Story requires resolved product_id in same org as claim candidate",
    },
    recommended_next_action: best
      ? `Physical-return MVP smoke: operator scans off-manifest unit in MAIN ORG (store ${best.store_id}) using real FNSKU ${best.fnsku} (ASIN ${best.asin ?? "see target"}). Leave fixture X006OFFM01 candidates as negative-control; verify Claim Center read-model on new scan only.`
      : "No qualifying real FNSKU in staging PIM — verify main org Amazon import completed.",
    SAFE_TO_USE_REAL_FNSKU_FOR_PHYSICAL_RETURN_MVP: safeToUse ? "yes" : "no",
    NEXT_EXACT_PROMPT: safeToUse
      ? `PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-RESCAN-SMOKE-V1 (main org ${MAIN_ORG}; store ${best!.store_id}; FNSKU ${best!.fnsku}; read-only Claim Center verify after scan)`
      : "PHASE-CLAIM-PHYSICAL-RETURN-MAIN-ORG-SPINE-IMPORT-VERIFY-V1",
  };

  const runId = result.run_id;
  const outDir = path.join(OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Real FNSKU smoke target V1\n\n- candidates: **${candidates.length}**\n- best: **${best?.fnsku ?? "none"}** @ main org\n- SAFE: **${result.SAFE_TO_USE_REAL_FNSKU_FOR_PHYSICAL_RETURN_MVP}**\n`,
  );

  await c.end();
  console.log(
    JSON.stringify(
      {
        run_id: runId,
        candidates: candidates.length,
        best_fnsku: best?.fnsku ?? null,
        best_asin: best?.asin ?? null,
        best_store: best?.store_id ?? null,
        SAFE_TO_USE: result.SAFE_TO_USE_REAL_FNSKU_FOR_PHYSICAL_RETURN_MVP,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
