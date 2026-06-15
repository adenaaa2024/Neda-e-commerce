/**
 * PHASE-P0-PRODUCT-SPINE-AND-AMAZON-SYNC-ROOT-CAUSE
 * Read-only audit — no writes, no fixes.
 *
 *   npx tsx scripts/phase-p0-product-spine-and-amazon-sync-root-cause-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { auditAmazonProductSyncHealth } from "../lib/amazon-product-sync-recovery";
import { AMAZON_SYNC_STALE_CUTOFF_ISO } from "../lib/amazon-product-sync-recovery-types";
import { RESOLUTION_ORDER_OPERATIONAL, RESOLUTION_ORDER_SCANNER } from "../lib/product-linkage-resolution-policy";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-p0-product-spine-and-amazon-sync-root-cause-v1";
const JUNE1 = AMAZON_SYNC_STALE_CUTOFF_ISO;

type Row = Record<string, unknown>;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function envFlag(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function connectReadOnly(url: string, refLabel: string): Promise<pg.Client> {
  if (refLabel === "original" && !url.includes(PRODUCTION_REF)) {
    throw new Error(`BLOCKED: original must target ${PRODUCTION_REF}`);
  }
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '180s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function tableExists(c: pg.Client, name: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [name],
  );
  return (r.rowCount ?? 0) > 0;
}

async function cols(c: pg.Client, table: string): Promise<Set<string>> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: Row) => String(x.column_name)));
}

async function juneGapStats(c: pg.Client): Promise<Row> {
  const productsCreated = await c.query(
    `SELECT count(*)::int AS n FROM products
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL
       AND created_at >= $3::timestamptz`,
    [ORG, STORE, JUNE1],
  );
  const productsUpdated = await c.query(
    `SELECT count(*)::int AS n FROM products
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL
       AND updated_at >= $3::timestamptz AND created_at < $3::timestamptz`,
    [ORG, STORE, JUNE1],
  );
  const productsStale = await c.query(
    `SELECT count(*)::int AS n FROM products
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL
       AND coalesce(last_catalog_sync_at, updated_at) < $3::timestamptz`,
    [ORG, STORE, JUNE1],
  );
  const mapCreated = (await tableExists(c, "product_identifier_map"))
    ? await c.query(
        `SELECT count(*)::int AS n FROM product_identifier_map
         WHERE organization_id=$1::uuid AND deleted_at IS NULL
           AND created_at >= $2::timestamptz`,
        [ORG, JUNE1],
      )
    : { rows: [{ n: 0 }] };
  const catalogUpdated = (await tableExists(c, "catalog_products"))
    ? await c.query(
        `SELECT count(*)::int AS n FROM catalog_products
         WHERE organization_id=$1::uuid AND store_id=$2::uuid
           AND updated_at >= $3::timestamptz`,
        [ORG, STORE, JUNE1],
      )
    : { rows: [{ n: 0 }] };
  const listingUploads = (await tableExists(c, "raw_report_uploads"))
    ? await c.query(
        `SELECT count(*)::int AS n,
                max(created_at)::text AS last_upload
         FROM raw_report_uploads
         WHERE organization_id=$1::uuid
           AND report_type = ANY($2::text[])
           AND created_at >= $3::timestamptz
           AND status NOT ILIKE '%fail%'`,
        [ORG, ["ALL_LISTINGS", "ACTIVE_LISTINGS", "CATEGORY_LISTINGS", "PRODUCT_IDENTITY"], JUNE1],
      )
    : { rows: [{ n: 0, last_upload: null }] };

  return {
    cutoff: JUNE1,
    products_created_since_june1: (productsCreated.rows[0] as Row).n,
    products_updated_since_june1: (productsUpdated.rows[0] as Row).n,
    products_stale_before_june1_cutoff: (productsStale.rows[0] as Row).n,
    product_identifier_map_rows_created_since_june1: (mapCreated.rows[0] as Row).n,
    catalog_products_updated_since_june1: (catalogUpdated.rows[0] as Row).n,
    listing_uploads_since_june1: (listingUploads.rows[0] as Row).n,
    last_listing_upload_at: (listingUploads.rows[0] as Row).last_upload,
  };
}

async function linkageReadiness(c: pg.Client): Promise<Row> {
  const mapCols = await cols(c, "product_identifier_map");
  const fnskuCol = mapCols.has("fnsku");

  const productsTotal = await c.query(
    `SELECT count(*)::int AS n FROM products
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL`,
    [ORG, STORE],
  );
  const mapTotal = await c.query(
    `SELECT count(*)::int AS n FROM product_identifier_map
     WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG],
  );
  const mapWithFnsku = fnskuCol
    ? await c.query(
        `SELECT count(*)::int AS n FROM product_identifier_map
         WHERE organization_id=$1::uuid AND deleted_at IS NULL
           AND fnsku IS NOT NULL AND btrim(fnsku) <> ''`,
        [ORG],
      )
    : { rows: [{ n: 0 }] };

  const slipUnmapped = (await tableExists(c, "slip_contents"))
    ? await c.query(
        `SELECT count(DISTINCT upper(btrim(sc.fnsku)))::int AS n
         FROM slip_contents sc
         WHERE sc.organization_id=$1::uuid AND sc.fnsku IS NOT NULL AND btrim(sc.fnsku) <> ''
           AND NOT EXISTS (
             SELECT 1 FROM product_identifier_map m
             WHERE m.organization_id=$1::uuid AND m.deleted_at IS NULL
               AND upper(btrim(m.fnsku)) = upper(btrim(sc.fnsku))
           )`,
        [ORG],
      )
    : { rows: [{ n: 0 }] };

  const ambiguousUpc = mapCols.has("upc_code")
    ? await c.query(
        `SELECT count(*)::int AS n FROM (
           SELECT regexp_replace(coalesce(upc_code,''), '\\D', '', 'g') AS u
           FROM product_identifier_map
           WHERE organization_id=$1::uuid AND deleted_at IS NULL
             AND upc_code IS NOT NULL AND btrim(upc_code) <> ''
           GROUP BY 1 HAVING count(DISTINCT product_id) > 1
         ) x`,
        [ORG],
      )
    : { rows: [{ n: 0 }] };

  const epCols = (await tableExists(c, "expected_packages")) ? await cols(c, "expected_packages") : new Set<string>();
  const epHasProductId = epCols.has("product_id");
  const epHasResolved = epCols.has("resolved_product_id");

  const epUnresolved = epCols.size && epHasResolved
    ? await c.query(
        `SELECT count(*)::int AS n FROM expected_packages
         WHERE organization_id=$1::uuid AND store_id=$2::uuid
           AND resolved_product_id IS NULL
           ${epHasProductId ? "AND product_id IS NULL" : ""}
           AND fnsku IS NOT NULL AND btrim(fnsku) <> ''`,
        [ORG, STORE],
      )
    : { rows: [{ n: 0 }] };

  const epResolved = epCols.size && (epHasResolved || epHasProductId)
    ? await c.query(
        `SELECT count(*)::int AS n FROM expected_packages
         WHERE organization_id=$1::uuid AND store_id=$2::uuid
           AND (${epHasResolved ? "resolved_product_id IS NOT NULL" : "false"} ${epHasProductId ? "OR product_id IS NOT NULL" : ""})`,
        [ORG, STORE],
      )
    : { rows: [{ n: 0 }] };

  return {
    products_total: (productsTotal.rows[0] as Row).n,
    product_identifier_map_rows: (mapTotal.rows[0] as Row).n,
    map_rows_with_fnsku: (mapWithFnsku.rows[0] as Row).n,
    slip_distinct_fnsku_without_map: (slipUnmapped.rows[0] as Row).n,
    ambiguous_upc_groups: (ambiguousUpc.rows[0] as Row).n,
    expected_packages_linked: (epResolved.rows[0] as Row).n,
    expected_packages_unresolved_with_fnsku: (epUnresolved.rows[0] as Row).n,
    shipment25_sample_unmapped_fnskus: ["ZZQDPD4GHB", "ZZQCP25AW3", "ZZQCUA7GMH"],
  };
}

async function auditBind(label: string, url: string, projectRef: string) {
  const c = await connectReadOnly(url, label);
  const rid = `${label}-${runId()}`;
  const recovery = await auditAmazonProductSyncHealth({
    pgClient: c,
    organizationId: ORG,
    storeId: STORE,
    runId: rid,
    projectRef,
  });
  const juneGap = await juneGapStats(c);
  const linkage = await linkageReadiness(c);
  await c.end();
  return { bind: label, ref: projectRef, recovery, june_gap: juneGap, linkage_readiness: linkage };
}

async function main() {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  bindProductionSupabaseEnv();
  const originalUrl = productionPostgresUrl();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL ?? process.env.DIRECT_POSTGRES_URL ?? "";

  const original = await auditBind("original", originalUrl, PRODUCTION_REF);
  let staging: Row | null = null;
  if (stagingUrl.includes("eiqfaapyumhixxoeltgu")) {
    staging = await auditBind("staging", stagingUrl, "eiqfaapyumhixxoeltgu");
  }

  const productIngestPipeline = {
    stages: [
      {
        stage: "1_amazon_api_or_file",
        sources: [
          "SP-API Catalog Items GET /catalog/2022-04-01/items/{asin} (enrichment only)",
          "SP-API Reports → synthetic upload → process/sync/generic (listings, identity CSV)",
          "Manual file upload via /api/settings/imports/*",
        ],
        stop_if: "No listing pull worker; Reports API workers are removal/financial only",
      },
      {
        stage: "2_raw_ingest",
        targets: [
          "amazon_listing_report_rows_raw (Phase 3 sync)",
          "catalog_products raw fields from listing Phase 4",
          "products.amazon_raw from enrichment batch",
        ],
        files: ["app/api/settings/imports/sync/route.ts", "lib/import-listing-canonical-sync.ts"],
      },
      {
        stage: "3_products_upsert",
        writers: [
          "lib/product-identity-import.ts (CSV identity — products upsert)",
          "lib/amazon-product-sync-promote.ts (governed promote — products INSERT only when enabled)",
          "lib/pim-catalog-enrichment-batch.ts (products UPDATE metadata/images — no create by default)",
        ],
        stop_point: "Auto-create forbidden — promote gated by PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED",
      },
      {
        stage: "4_product_identifier_map",
        writers: [
          "lib/product-identifier-map-sync.ts ← listing Phase 4",
          "lib/product-identity-import.ts ← identity CSV",
          "lib/inventory-ledger-identifier-enrich.ts ← ledger Phase 4",
          "lib/pim-product-map-upsert.ts ← PIM manual / promote",
        ],
        stop_point: "No scheduled map backfill; map only on import/enrich/manual paths",
      },
      {
        stage: "5_image_sync",
        path: "pim-catalog-enrichment-batch → extractBestMainImageFromCatalogItem → products.main_image_url",
        gate: "AMAZON_SP_API_ENABLED + product_enrichment job or enrich-images route",
        note: "Listing CSV does not set main_image_url",
      },
    ],
    pipeline_stops_since_june1: [
      "product_enrichment schedule disabled (default + likely platform_settings)",
      "No Vercel cron for product catalog — manual/operator enqueue only",
      "Listing report automation not wired — file upload only",
      "ZZQ* FNSKUs never entered map via any pipeline (removal/slip path, not listing)",
    ],
  };

  const identifierMapPipeline = {
    creators: [
      { who: "listing Phase 4", when: "after catalog_products upsert", file: "lib/product-identifier-map-sync.ts" },
      { who: "product identity CSV", when: "sync PRODUCT_IDENTITY kind", file: "lib/product-identity-import.ts" },
      { who: "inventory ledger Phase 4", when: "FNSKU bridge after ledger generic", file: "lib/inventory-ledger-identifier-enrich.ts" },
      { who: "amazon sync promote", when: "governed product insert", file: "lib/pim-product-map-upsert.ts" },
      { who: "PIM manual save", when: "operator edits identifiers", file: "lib/pim-product-map-upsert.ts" },
    ],
    not_creators: [
      "Scanner resolver (read-only)",
      "Claim generator (copies source cols)",
      "Removal sync (expected_packages only)",
      "Slip OCR / return_items scan (resolve only, no map insert)",
    ],
    scheduled: false,
    failure_points: [
      "Listing file not uploaded since June 1 → no new map rows from listings",
      "product_enrichment disabled/cancelled → no catalog refresh → stale products/images",
      "Auto-create disabled → ASINs in catalog_products never promoted to products+map",
      "Operational FNSKUs (ZZQ*) from removals/slips not covered by listing/ledger paths",
    ],
  };

  const imagePipeline = {
    source_apis: ["SP-API Catalog Items (images in catalog JSON)"],
    entry_routes: [
      "POST /api/dashboard/products/catalog/enrich-images",
      "background_jobs job_type=product_enrichment",
    ],
    last_refresh_proxy: original.recovery.last_successful_sync,
    stale_images: original.recovery.image_sync_failures,
    max_last_catalog_sync_at: original.recovery.counts.max_last_catalog_sync_at,
  };

  const rootCauseParts = [
    ...original.recovery.root_cause_summary,
    `${original.linkage_readiness.slip_distinct_fnsku_without_map} distinct slip FNSKUs have zero map rows`,
    `${original.june_gap.products_stale_before_june1_cutoff} products stale since ${JUNE1.slice(0, 10)}`,
  ];

  const rootCauseClassification = {
    scheduler: original.recovery.scheduler_status.enabled === false ? "YES — product_enrichment schedule disabled" : "partial",
    cron: "YES — no Vercel cron for product catalog (only removal nightly)",
    api_auth: original.recovery.api_connectivity.ok ? "no — SP-API token OK when probed" : `possible — ${original.recovery.api_connectivity.error}`,
    pagination: "n/a for catalog enrich (batch capped per run)",
    rate_limit: `batch delay ${original.recovery.sync_jobs.rate_limit_delay_ms}ms max ${original.recovery.sync_jobs.max_per_run}/run`,
    ingest_failure: original.june_gap.listing_uploads_since_june1 === 0 ? "YES — zero listing uploads since June 1" : "partial",
    upsert_failure: "no evidence — upsert paths exist but not triggered",
    identifier_creation_failure: "YES — map rows only on import/manual; operational FNSKUs never ingested",
    image_sync_failure: original.recovery.image_sync_failures.total > 0 ? `YES — ${original.recovery.image_sync_failures.total} image issues` : "partial",
    deployment_config: !envFlag("AMAZON_SP_API_ENABLED") ? "YES — AMAZON_SP_API_ENABLED may be false in some envs" : "partial",
  };

  const requiredFixes = [
    "Enable + schedule product_enrichment in platform_settings (or operator enqueue cadence)",
    "Governed product_identifier_map inserts for operational FNSKUs (Shipment 25 ZZQ* — separate approval)",
    "Optional: listing report upload cadence or SP-API listing worker (not built)",
    "Optional: governed promote for catalog_products ASINs missing from products (PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED)",
    "Run catalog enrich-images batch to refresh stale products/images after scheduler restored",
  ];

  const result = {
    phase: "PHASE-P0-PRODUCT-SPINE-AND-AMAZON-SYNC-ROOT-CAUSE",
    run_id: rid,
    mode: "audit_only",
    DO_NOT_FIX_YET: true,
    resolver_order: {
      scanner: RESOLUTION_ORDER_SCANNER,
      operational: RESOLUTION_ORDER_OPERATIONAL,
    },
    env_flags: {
      AMAZON_SP_API_ENABLED: envFlag("AMAZON_SP_API_ENABLED"),
      PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED: envFlag("PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED"),
      PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED: envFlag("PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED"),
      ENABLE_AMAZON_REPORTS_API_WORKER: envFlag("ENABLE_AMAZON_REPORTS_API_WORKER"),
    },
    product_sync_jobs: {
      product_enrichment: {
        type: "background_jobs product_enrichment",
        scheduled: original.recovery.scheduler_status,
        executor: "platform-automation-scheduler-tick + /api/jobs/tick (no Vercel cron)",
        environment: "original primary",
        source_store_count: 1,
      },
      listing_csv_import: {
        type: "manual file ETL",
        kinds: ["ALL_LISTINGS", "ACTIVE_LISTINGS", "CATEGORY_LISTINGS", "PRODUCT_IDENTITY"],
        scheduled: false,
        last_upload_since_june1: original.june_gap.last_listing_upload_at,
      },
      catalog_sp_api_enrich: {
        type: "SP-API Catalog Items batch",
        gated_by: "AMAZON_SP_API_ENABLED",
        updates: "products metadata + main_image_url (existing products only)",
      },
      amazon_sync_recovery_promote: {
        type: "governed promote missing ASINs",
        gated_by: "PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED",
        auto_create_forbidden_by_policy: true,
      },
      removal_nightly: {
        type: "vercel cron removal-nightly-sync",
        note: "feeds removals/EP — not product spine catalog",
      },
    },
    last_successful_runs: {
      product_enrichment_job: original.recovery.last_successful_sync,
      max_product_updated_at: original.recovery.counts.max_product_updated_at,
      max_last_catalog_sync_at: original.recovery.counts.max_last_catalog_sync_at,
      scheduler_next_run: original.recovery.scheduler_status.next_run_at,
    },
    failed_jobs: {
      cancelled_or_failed_since_june1: original.recovery.scheduler_status.cancelled_jobs_after_june,
      last_job_status: original.recovery.scheduler_status.last_job_status,
      last_job_at: original.recovery.scheduler_status.last_job_at,
      recent_jobs: original.recovery.sync_jobs.recent_jobs,
    },
    product_ingest_pipeline: productIngestPipeline,
    identifier_map_pipeline: identifierMapPipeline,
    image_pipeline: imagePipeline,
    products_missing_since_june: {
      original: original.june_gap,
      staging: staging?.june_gap ?? null,
      catalog_asins_missing_products_spine: original.recovery.products_missing,
      products_stale_count: original.recovery.products_stale,
    },
    linkage_readiness: original.linkage_readiness,
    original_recovery_report: original.recovery,
    staging_snapshot: staging?.recovery ?? null,
    root_cause: rootCauseParts.join("; "),
    root_cause_classification: rootCauseClassification,
    required_fixes: requiredFixes,
    SAFE_TO_IMPLEMENT_FIX: "no",
    SAFE_TO_IMPLEMENT_FIX_note: "Scheduler re-enable + governed map inserts require operator approval; auto-create remains forbidden",
    DO_NOT_FIX_YET: true,
  };

  fs.writeFileSync(path.join(outDir, "audit-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "audit-summary.md"),
    `# P0 Product Spine & Amazon Sync Root Cause

**Run:** ${rid}
**Target:** original \`${PRODUCTION_REF}\`

## Root cause
${rootCauseParts.map((x) => `- ${x}`).join("\n")}

## June 1 gap (original)
- Products created: ${original.june_gap.products_created_since_june1}
- Products updated: ${original.june_gap.products_updated_since_june1}
- Products stale: ${original.june_gap.products_stale_before_june1_cutoff}
- Map rows created: ${original.june_gap.product_identifier_map_rows_created_since_june1}
- Listing uploads: ${original.june_gap.listing_uploads_since_june1}

## Linkage readiness
- Products: ${original.linkage_readiness.products_total}
- Map rows: ${original.linkage_readiness.product_identifier_map_rows}
- Slip FNSKUs without map: ${original.linkage_readiness.slip_distinct_fnsku_without_map}

**DO_NOT_FIX_YET**
`,
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid }, null, 2));

  console.log(
    JSON.stringify(
      {
        run_id: rid,
        root_cause: rootCauseClassification,
        SAFE_TO_IMPLEMENT_FIX: "no",
        DO_NOT_FIX_YET: true,
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
