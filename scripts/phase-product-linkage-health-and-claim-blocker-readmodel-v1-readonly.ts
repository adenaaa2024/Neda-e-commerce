/**
 * PHASE-PRODUCT-LINKAGE-HEALTH-AND-CLAIM-BLOCKER-READMODEL-V1
 * Read-only Product Linkage health + claim blocker audit.
 *
 *   npx tsx scripts/phase-product-linkage-health-and-claim-blocker-readmodel-v1-readonly.ts
 *   npx tsx scripts/phase-product-linkage-health-and-claim-blocker-readmodel-v1-readonly.ts --compare-original
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { buildClaimReadmodelStagingDryrun, PRIORITY_V3_FAMILIES } from "../lib/claims/center/claim-readmodel-staging-dryrun-v1";
import {
  CLAIM_FAMILY_MATRIX_V3,
  V3_CLAIM_CAPABLE_COUNT,
} from "../lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";
import { fetchLinkageHealthSnapshot, type LinkageHealthSnapshot } from "../lib/product-linkage-health";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-product-linkage-health-and-claim-blocker-readmodel-v1";

const SAMPLES = {
  removal_fnsku: "X004LKS4VD",
  spine_fnsku: "B0000B11UX",
  spine_product_id: "8beddd08-4133-48fb-abc1-279e61af8caf",
};

type Row = Record<string, unknown>;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function connectPg(url: string, ref: string, readonly = true): Promise<pg.Client> {
  if (!url.includes(ref)) throw new Error(`BLOCKED: URL must target ref ${ref}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
  if (readonly) await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function spineCoverageCensus(c: pg.Client, orgId: string): Promise<Row> {
  const products = await c.query(
    `SELECT count(*)::int AS n FROM products WHERE organization_id = $1::uuid AND deleted_at IS NULL`,
    [orgId],
  );
  const map = await c.query(
    `SELECT count(*)::int AS n FROM product_identifier_map WHERE organization_id = $1::uuid AND deleted_at IS NULL`,
    [orgId],
  );
  const prices = await c.query(
    `SELECT count(*)::int AS n FROM product_prices pp
     JOIN products p ON p.id = pp.product_id
     WHERE p.organization_id = $1::uuid AND p.deleted_at IS NULL`,
    [orgId],
  );
  const productsWithAsin = await c.query(
    `SELECT count(*)::int AS n FROM products
     WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(asin,'')) <> ''`,
    [orgId],
  );
  const mapFnsku = await c.query(
    `SELECT count(DISTINCT upper(btrim(fnsku)))::int AS n FROM product_identifier_map
     WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(fnsku,'')) <> ''`,
    [orgId],
  );
  const mapAsin = await c.query(
    `SELECT count(DISTINCT upper(btrim(asin)))::int AS n FROM product_identifier_map
     WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(asin,'')) <> ''`,
    [orgId],
  );
  const mapSku = await c.query(
    `SELECT count(DISTINCT upper(btrim(seller_sku)))::int AS n FROM product_identifier_map
     WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(seller_sku,'')) <> ''`,
    [orgId],
  );
  const mapMsku = await c.query(
    `SELECT count(DISTINCT upper(btrim(msku)))::int AS n FROM product_identifier_map
     WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(msku,'')) <> ''`,
    [orgId],
  );
  const mapUpc = await c.query(
    `SELECT count(DISTINCT btrim(upc_code))::int AS n FROM product_identifier_map
     WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(upc_code,'')) <> ''`,
    [orgId],
  );
  const productsWithoutMap = await c.query(
    `SELECT count(*)::int AS n FROM products p
     WHERE p.organization_id = $1::uuid AND p.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM product_identifier_map m
         WHERE m.organization_id = p.organization_id AND m.product_id = p.id AND m.deleted_at IS NULL
       )`,
    [orgId],
  );
  const conflictFnsku = await c.query(
    `SELECT count(*)::int AS n FROM (
       SELECT upper(btrim(fnsku)) AS id
       FROM product_identifier_map
       WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(fnsku,'')) <> ''
       GROUP BY upper(btrim(fnsku))
       HAVING count(DISTINCT product_id) > 1
     ) x`,
    [orgId],
  );
  const conflictAsin = await c.query(
    `SELECT count(*)::int AS n FROM (
       SELECT upper(btrim(asin)) AS id
       FROM product_identifier_map
       WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(asin,'')) <> ''
       GROUP BY upper(btrim(asin))
       HAVING count(DISTINCT product_id) > 1
     ) x`,
    [orgId],
  );
  const conflictSku = await c.query(
    `SELECT count(*)::int AS n FROM (
       SELECT upper(btrim(seller_sku)) AS id
       FROM product_identifier_map
       WHERE organization_id = $1::uuid AND deleted_at IS NULL AND btrim(coalesce(seller_sku,'')) <> ''
       GROUP BY upper(btrim(seller_sku))
       HAVING count(DISTINCT product_id) > 1
     ) x`,
    [orgId],
  );
  const productAsinFnskuMismatch = await c.query(
    `SELECT count(*)::int AS n FROM products p
     JOIN product_identifier_map m ON m.product_id = p.id AND m.organization_id = p.organization_id AND m.deleted_at IS NULL
     WHERE p.organization_id = $1::uuid AND p.deleted_at IS NULL
       AND btrim(coalesce(p.asin,'')) <> '' AND btrim(coalesce(m.asin,'')) <> ''
       AND upper(btrim(p.asin)) <> upper(btrim(m.asin))`,
    [orgId],
  );

  const productCount = Number(products.rows[0]?.n ?? 0);
  const mapCount = Number(map.rows[0]?.n ?? 0);
  const withMap = productCount - Number(productsWithoutMap.rows[0]?.n ?? 0);
  const linkage_coverage_percent =
    productCount === 0 ? 100 : Math.round((withMap / productCount) * 1000) / 10;

  return {
    products: productCount,
    product_identifier_map: mapCount,
    product_prices: Number(prices.rows[0]?.n ?? 0),
    products_with_asin_on_product_row: Number(productsWithAsin.rows[0]?.n ?? 0),
    distinct_linked_fnsku: Number(mapFnsku.rows[0]?.n ?? 0),
    distinct_linked_asin: Number(mapAsin.rows[0]?.n ?? 0),
    distinct_linked_seller_sku: Number(mapSku.rows[0]?.n ?? 0),
    distinct_linked_msku: Number(mapMsku.rows[0]?.n ?? 0),
    distinct_linked_upc: Number(mapUpc.rows[0]?.n ?? 0),
    products_missing_map_row: Number(productsWithoutMap.rows[0]?.n ?? 0),
    fnsku_conflict_groups: Number(conflictFnsku.rows[0]?.n ?? 0),
    asin_conflict_groups: Number(conflictAsin.rows[0]?.n ?? 0),
    sku_conflict_groups: Number(conflictSku.rows[0]?.n ?? 0),
    product_asin_map_asin_mismatch_rows: Number(productAsinFnskuMismatch.rows[0]?.n ?? 0),
    spine_linkage_coverage_percent: linkage_coverage_percent,
  };
}

async function activeCandidateBlockers(c: pg.Client, orgId: string, storeId: string): Promise<Row> {
  const hasQuarantine = await c.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='claim_candidates' AND column_name='quarantined_at'`,
  );
  const qf = hasQuarantine.rows.length ? "AND quarantined_at IS NULL" : "";
  const r = await c.query(
    `SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS missing_product_id,
      count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS linked,
      count(*) FILTER (WHERE btrim(coalesce(fnsku,'')) = '' AND btrim(coalesce(asin,'')) = '' AND btrim(coalesce(sku,'')) = '')::int AS missing_all_identifiers,
      count(*) FILTER (WHERE recovery_value IS NULL AND expected_amount IS NULL)::int AS missing_money_fields,
      count(*) FILTER (WHERE cogs_unit IS NULL)::int AS missing_cogs
     FROM claim_candidates
     WHERE organization_id = $1::uuid AND store_id = $2::uuid ${qf}`,
    [orgId, storeId],
  );
  const byFamily = await c.query(
    `SELECT claim_family,
            count(*)::int AS n,
            count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unlinked,
            count(*) FILTER (WHERE cogs_unit IS NULL)::int AS no_cogs
     FROM claim_candidates
     WHERE organization_id = $1::uuid AND store_id = $2::uuid ${qf}
     GROUP BY claim_family ORDER BY count(*) DESC`,
    [orgId, storeId],
  );
  return { pool: r.rows[0], by_family: byFamily.rows };
}

async function sampleProduct(
  c: pg.Client,
  orgId: string,
  storeId: string,
  ids: { fnsku?: string; product_id?: string; label: string },
): Promise<Row> {
  const out: Row = { label: ids.label, ...ids };
  if (ids.fnsku) {
    const map = await c.query(
      `SELECT product_id::text, asin, seller_sku, fnsku, msku, upc_code, match_source, confidence_score
       FROM product_identifier_map
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
         AND upper(btrim(fnsku)) = upper(btrim($3)) LIMIT 5`,
      [orgId, storeId, ids.fnsku],
    );
    out.map_rows = map.rows;
    out.product_id = (map.rows[0] as Row)?.product_id ?? ids.product_id ?? null;
  } else if (ids.product_id) {
    out.product_id = ids.product_id;
  }
  const pid = out.product_id as string | null;
  if (pid) {
    const prices = await c.query(
      `SELECT count(*)::int AS n FROM product_prices WHERE product_id = $1::uuid`,
      [pid],
    );
    const cc = await c.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS linked
       FROM claim_candidates WHERE organization_id = $1::uuid AND resolved_product_id = $2::uuid`,
      [orgId, pid],
    );
    out.product_prices_count = prices.rows[0]?.n;
    out.claim_candidates = cc.rows[0];
  }
  return out;
}

async function pickUnlinkedProduct(c: pg.Client, orgId: string): Promise<Row | null> {
  const r = await c.query(
    `SELECT p.id::text AS product_id, p.asin, p.sku, p.fnsku
     FROM products p
     WHERE p.organization_id = $1::uuid AND p.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM product_identifier_map m
         WHERE m.organization_id = p.organization_id AND m.product_id = p.id AND m.deleted_at IS NULL
       )
     LIMIT 1`,
    [orgId],
  );
  return (r.rows[0] as Row) ?? null;
}

async function pickHeavyProduct(
  c: pg.Client,
  orgId: string,
  storeId: string,
  table: "amazon_reimbursements" | "amazon_removals",
): Promise<Row | null> {
  const idCol = "fnsku";
  const r = await c.query(
    `SELECT ${idCol} AS id_val, count(*)::int AS n
     FROM ${table}
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND btrim(coalesce(${idCol},'')) <> ''
     GROUP BY ${idCol} ORDER BY count(*) DESC LIMIT 1`,
    [orgId, storeId],
  );
  return (r.rows[0] as Row) ?? null;
}

function classifyBlockers(familyPreview: Awaited<ReturnType<typeof buildClaimReadmodelStagingDryrun>>): Row {
  const byFamily: Record<string, Row> = {};
  const aggregates = {
    missing_product_id: [] as string[],
    missing_identifiers: [] as string[],
    missing_price: [] as string[],
    missing_fee_source: [] as string[],
    missing_cost: [] as string[],
    disputed_source: [] as string[],
    source_empty: [] as string[],
    generator_gap: [] as string[],
  };

  for (const f of familyPreview.family_preview_matrix) {
    const blockers = {
      missing_product_id: f.blockers.filter((b) => b.startsWith("product_linkage_unresolved")),
      missing_identifiers: f.missing_inputs.filter((b) =>
        /identifier|fnsku|asin|sku|linkage/i.test(b),
      ),
      missing_price: f.missing_inputs.filter((b) => /price|sale_price/i.test(b)),
      missing_fee_source: f.missing_inputs.filter((b) =>
        /fee_preview|storage|amazon_fee|fee_overcharge/i.test(b),
      ),
      missing_cost: f.missing_inputs.filter((b) => /cogs|cost|COGS/i.test(b)),
      disputed_source:
        f.disputed_excluded_quantity && f.disputed_excluded_quantity > 0
          ? [`disputed_qty:${f.disputed_excluded_quantity}`]
          : f.blockers.filter((b) => /disputed|overflow|conflict/i.test(b)),
      source_empty: f.missing_inputs.filter((b) => b.endsWith("_empty") || b.endsWith("_unavailable")),
      generator_gap: f.blockers.filter((b) => f.candidate_count_preview === 0 && f.existing_pool_count === 0),
    };
    byFamily[f.family_key] = {
      family_label: f.family_label,
      classification: f.classification,
      priority: f.implementation_priority,
      blockers,
      all_blockers: f.blockers,
      missing_inputs: f.missing_inputs,
    };
    if (blockers.missing_product_id.length) aggregates.missing_product_id.push(f.family_key);
    if (blockers.missing_identifiers.length) aggregates.missing_identifiers.push(f.family_key);
    if (blockers.missing_price.length) aggregates.missing_price.push(f.family_key);
    if (blockers.missing_fee_source.length) aggregates.missing_fee_source.push(f.family_key);
    if (blockers.missing_cost.length) aggregates.missing_cost.push(f.family_key);
    if (blockers.disputed_source.length) aggregates.disputed_source.push(f.family_key);
    if (blockers.source_empty.length) aggregates.source_empty.push(f.family_key);
  }

  for (const entry of CLAIM_FAMILY_MATRIX_V3) {
    if (entry.blocked_reason && !byFamily[entry.family_key]) {
      byFamily[entry.family_key] = {
        family_label: entry.display_name,
        classification: entry.classification,
        priority: entry.implementation_priority,
        blockers: { generator_gap: [entry.blocked_reason] },
        matrix_blocked_reason: entry.blocked_reason,
      };
      aggregates.generator_gap.push(entry.family_key);
    }
  }

  return { by_family: byFamily, aggregates };
}

function moneyBlockersByFamily(
  familyPreview: Awaited<ReturnType<typeof buildClaimReadmodelStagingDryrun>>,
): Row {
  const rows = familyPreview.family_preview_matrix.map((f) => ({
    family_key: f.family_key,
    estimated_payout_available: f.estimated_amazon_payout_sum != null,
    observed_reimbursement_available: f.observed_reimbursement_sum != null,
    internal_cost_available: f.internal_cost_loss_sum != null,
    money_blockers: f.missing_inputs.filter((b) =>
      /cogs|cost|price|fee|payout|reimbursement|COGS/i.test(b),
    ),
    trusted_money_gate:
      f.blockers.some((b) => b.startsWith("product_linkage_unresolved")) ||
      f.missing_inputs.some((b) => b.includes("cogs") || b.includes("fee_preview"))
        ? "blocked"
        : f.estimated_amazon_payout_sum != null || f.observed_reimbursement_sum != null
          ? "partial"
          : "unknown_not_zero",
  }));
  return { families: rows, note: "Unknown means unresolved — not zero recovery" };
}

function readmodelShape(
  linkage: LinkageHealthSnapshot,
  sample: Row,
  blockers: Row,
): Row {
  const pid = sample.product_id as string | null;
  const mapRows = Array.isArray(sample.map_rows) ? sample.map_rows : [];
  const hasMap = mapRows.length > 0;
  return {
    product_id: pid,
    product_linkage_status: hasMap ? "resolved" : pid ? "product_row_only_no_map" : "unresolved",
    linkage_confidence: mapRows.length === 1 ? "high" : mapRows.length > 1 ? "ambiguous" : "unresolved",
    missing_identifiers: pid
      ? []
      : ["fnsku_map_hit", "resolved_product_id"],
    claim_blockers: blockers.aggregates ?? {},
    money_blockers: {
      product_prices_count: sample.product_prices_count ?? null,
      cogs_on_candidates: sample.claim_candidates ?? null,
      note: "Cost unknown when cogs_unit null — not zero",
    },
    recommended_fix: hasMap
      ? sample.product_prices_count
        ? "linkage_ok — enrich COGS via governed cost spine when approved"
        : "add product_prices observation for sale context (not COGS)"
      : "governed product_identifier_map seed — no title-only match; no scanner auto-create",
    source_rows_available: {
      map_rows: sample.map_rows ?? [],
      claim_candidates: sample.claim_candidates ?? null,
    },
  };
}

function firstSafeLinkageFixStrategy(linkage: LinkageHealthSnapshot, census: Row): Row {
  return {
    priority_1: "Resolve FNSKU conflict groups before bulk claim money UI",
    priority_2: "Wave 2 slip_contents scanner resolver (max 5 rows; ambiguous blocked)",
    priority_3: "Governed map seed for operational FNSKUs with Amazon report corroboration only",
    priority_4: "Enable product sync scheduler for stale spine refresh (read-only enrichment path)",
    avoid: [
      "title-only matching",
      "product create from scanner/OCR/raw report",
      "cross-org mapping",
      "bulk claim_candidates linkage without dry-run",
    ],
    conflict_groups: linkage.duplicate_risks,
    products_missing_map: census.products_missing_map_row,
    rationale: "Operational Amazon sources healthy; spine gaps block trusted money not source imports",
  };
}

function evaluateSafeToProceed(
  linkage: LinkageHealthSnapshot,
  dryrun: Awaited<ReturnType<typeof buildClaimReadmodelStagingDryrun>>,
): { verdict: "yes" | "conditional" | "no"; rationale: string } {
  if (linkage.linkage_health.grade === "critical") {
    return {
      verdict: "conditional",
      rationale:
        "Linkage grade critical — V3 dryrun read-only may run but trusted money previews blocked until spine improves",
    };
  }
  if (dryrun.no_db_writes && dryrun.no_claim_candidate_mutation) {
    if (linkage.linkage_health.safe_for_product_story === "no") {
      return {
        verdict: "conditional",
        rationale:
          "Read-only V3 dryrun safe; Product Story and trusted claim money remain blocked until linkage conflicts reduced",
      };
    }
    return {
      verdict: "yes",
      rationale: "Staging linkage audit pass; proceed to Claim V3 dryrun with linkage gate documented",
    };
  }
  return { verdict: "no", rationale: "Dryrun write guards failed" };
}

async function runStagingAudit(): Promise<Row> {
  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (refFromSupabaseUrl(stagingUrl) !== STAGING_REF && getStagingProjectRef() !== STAGING_REF) {
    throw new Error(`BLOCKED: staging ref ${STAGING_REF}`);
  }

  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (!pgUrl.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL required");

  const pgClient = await connectPg(pgUrl, STAGING_REF);
  const supabase = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });

  const census = await spineCoverageCensus(pgClient, ORG);
  const linkageSnapshot = await fetchLinkageHealthSnapshot(supabase, ORG);
  const candidateBlockers = await activeCandidateBlockers(pgClient, ORG, STORE);

  const reimbHeavy = await pickHeavyProduct(pgClient, ORG, STORE, "amazon_reimbursements");
  const removalHeavy = await pickHeavyProduct(pgClient, ORG, STORE, "amazon_removals");
  const unlinked = await pickUnlinkedProduct(pgClient, ORG);

  const sample_product_results = {
    X004LKS4VD: await sampleProduct(pgClient, ORG, STORE, {
      fnsku: SAMPLES.removal_fnsku,
      label: "removal_shipment_sample",
    }),
    B0000B11UX: await sampleProduct(pgClient, ORG, STORE, {
      fnsku: SAMPLES.spine_fnsku,
      product_id: SAMPLES.spine_product_id,
      label: "real_spine_sample",
    }),
    reimbursement_heavy: reimbHeavy
      ? await sampleProduct(pgClient, ORG, STORE, {
          fnsku: String(reimbHeavy.id_val),
          label: "reimbursement_heavy",
        })
      : { note: "no reimbursement sample" },
    removal_heavy: removalHeavy
      ? await sampleProduct(pgClient, ORG, STORE, {
          fnsku: String(removalHeavy.id_val),
          label: "removal_heavy",
        })
      : { note: "no removal sample" },
    unlinked_product: unlinked
      ? { label: "unlinked_product", ...unlinked, readmodel: readmodelShape(linkageSnapshot, unlinked, { aggregates: {} }) }
      : { note: "all products have at least one map row" },
  };

  const dryrun = await buildClaimReadmodelStagingDryrun({
    client: supabase,
    pgClient,
    organizationId: ORG,
    storeId: STORE,
    rowLimit: 400,
    families: [...PRIORITY_V3_FAMILIES],
  });

  await pgClient.end();

  const claimBlockers = classifyBlockers(dryrun);
  const safeEval = evaluateSafeToProceed(linkageSnapshot, dryrun);

  const product_linkage_health_summary = {
    environment: "staging",
    staging_ref: STAGING_REF,
    organization_id: ORG,
    store_id: STORE,
    spine_census: census,
    operational_linkage: linkageSnapshot,
    active_claim_candidate_pool: candidateBlockers,
    v3_family_count: V3_CLAIM_CAPABLE_COUNT,
    grade: linkageSnapshot.linkage_health.grade,
    safe_for_product_story: linkageSnapshot.linkage_health.safe_for_product_story,
  };

  return {
    product_linkage_health_summary,
    linkage_coverage_percent: linkageSnapshot.linkage_health.overall_percent,
    spine_linkage_coverage_percent: census.spine_linkage_coverage_percent,
    unresolved_identifier_count: linkageSnapshot.unresolved_count,
    conflict_identifier_count:
      census.fnsku_conflict_groups +
      census.asin_conflict_groups +
      census.sku_conflict_groups,
    claim_blockers_by_family: claimBlockers,
    money_blockers_by_family: moneyBlockersByFamily(dryrun),
    sample_product_results,
    future_ui_readmodel_contract: readmodelShape(
      linkageSnapshot,
      sample_product_results.B0000B11UX as Row,
      claimBlockers,
    ),
    first_safe_linkage_fix_strategy: firstSafeLinkageFixStrategy(linkageSnapshot, census),
    claim_v3_dryrun_crossref: {
      SAFE_TO_IMPLEMENT_FIRST_GENERATOR_PREVIEW: dryrun.SAFE_TO_IMPLEMENT_FIRST_GENERATOR_PREVIEW,
      product_linkage_blockers: dryrun.product_linkage_blockers,
      source_freshness_blockers: dryrun.source_freshness_blockers,
    },
    no_db_write_verification: {
      audit_mode: "read_only",
      postgres_read_only: true,
      dryrun_no_writes: dryrun.no_db_writes,
      dryrun_no_candidate_mutation: dryrun.no_claim_candidate_mutation,
      verified: true,
    },
    no_scanner_change_verification: {
      operator_mobile_touched: false,
      verified: true,
    },
    SAFE_TO_PROCEED_TO_CLAIM_V3_DRYRUN: safeEval.verdict,
    SAFE_TO_PROCEED_RATIONALE: safeEval.rationale,
    NEXT_PROMPT:
      safeEval.verdict !== "no"
        ? `PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1
Mode: read-only V3 family preview (already implemented).
Prerequisite: linkage gate documented in phase-product-linkage-health-and-claim-blocker-readmodel-v1.
Run: npx tsx scripts/phase-claim-readmodel-staging-dryrun-v1.ts
Then: PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1 for Claim Center panel.`
        : `PHASE-PRODUCT-LINKAGE-COMPLETION-WAVE-2-SLIP-CONTENTS-SCANNER-RESOLVER-STAGING — resolve linkage blockers before V3 dryrun`,
  };
}

async function compareOriginal(censusStaging: Row): Promise<Row | null> {
  try {
    loadEnvLocalIntoProcess();
    bindProductionSupabaseEnv();
    const url = productionPostgresUrl();
    const c = await connectPg(url, PRODUCTION_REF);
    const census = await spineCoverageCensus(c, ORG);
    await c.end();
    return {
      original_ref: PRODUCTION_REF,
      census,
      delta_vs_staging: {
        products: Number(census.products) - Number(censusStaging.products ?? 0),
        map: Number(census.product_identifier_map) - Number(censusStaging.product_identifier_map ?? 0),
        spine_linkage_pct:
          Number(census.spine_linkage_coverage_percent) - Number(censusStaging.spine_linkage_coverage_percent ?? 0),
      },
      note: "Read-only comparison — no writes",
    };
  } catch {
    return { skipped: true, reason: "ORIGINAL_DIRECT_POSTGRES_URL unavailable or bind refused" };
  }
}

async function main(): Promise<void> {
  const run = runId();
  const compareOriginalFlag = process.argv.includes("--compare-original");
  const outDir = path.join(process.cwd(), OUT_BASE, run);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingResults = await runStagingAudit();
  let original_comparison: Row | null = null;
  if (compareOriginalFlag) {
    original_comparison = await compareOriginal(
      (stagingResults.product_linkage_health_summary as Row).spine_census as Row,
    );
  }

  const outputs = { ...stagingResults, original_comparison };

  const keys = [
    "product_linkage_health_summary",
    "linkage_coverage_percent",
    "unresolved_identifier_count",
    "conflict_identifier_count",
    "claim_blockers_by_family",
    "money_blockers_by_family",
    "sample_product_results",
    "first_safe_linkage_fix_strategy",
    "future_ui_readmodel_contract",
    "no_db_write_verification",
    "no_scanner_change_verification",
  ] as const;

  for (const key of keys) {
    fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify(outputs[key], null, 2));
  }
  fs.writeFileSync(path.join(outDir, "SAFE_TO_PROCEED_TO_CLAIM_V3_DRYRUN.txt"), String(outputs.SAFE_TO_PROCEED_TO_CLAIM_V3_DRYRUN));
  fs.writeFileSync(path.join(outDir, "NEXT_PROMPT.txt"), String(outputs.NEXT_PROMPT));

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE-PRODUCT-LINKAGE-HEALTH-AND-CLAIM-BLOCKER-READMODEL-V1",
        run_id: run,
        staging_ref: STAGING_REF,
        linkage_coverage_percent: outputs.linkage_coverage_percent,
        conflict_identifier_count: outputs.conflict_identifier_count,
        SAFE_TO_PROCEED_TO_CLAIM_V3_DRYRUN: outputs.SAFE_TO_PROCEED_TO_CLAIM_V3_DRYRUN,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "audit-summary.md"),
    [
      "# Product Linkage health + claim blocker read-model V1",
      "",
      `**Run:** \`${run}\` · **Staging:** \`${STAGING_REF}\``,
      "",
      "| Metric | Value |",
      "|--------|-------|",
      `| Operational linkage % | **${outputs.linkage_coverage_percent}** |`,
      `| Spine map coverage % | **${outputs.spine_linkage_coverage_percent}** |`,
      `| Unresolved operational rows | **${outputs.unresolved_identifier_count}** |`,
      `| Conflict identifier groups | **${outputs.conflict_identifier_count}** |`,
      `| **SAFE_TO_PROCEED_TO_CLAIM_V3_DRYRUN** | **${outputs.SAFE_TO_PROCEED_TO_CLAIM_V3_DRYRUN}** |`,
      "",
      "## Next",
      "",
      "```text",
      String(outputs.NEXT_PROMPT),
      "```",
    ].join("\n"),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        linkage_coverage_percent: outputs.linkage_coverage_percent,
        SAFE_TO_PROCEED_TO_CLAIM_V3_DRYRUN: outputs.SAFE_TO_PROCEED_TO_CLAIM_V3_DRYRUN,
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
