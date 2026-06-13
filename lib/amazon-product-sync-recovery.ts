import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import {
  AMAZON_PRODUCT_SYNC_MATCH_SOURCE,
  AMAZON_SYNC_STALE_CUTOFF_ISO,
  type AmazonProductSyncCatchUpResult,
  type AmazonProductSyncRecoveryReport,
} from "./amazon-product-sync-recovery-types";
import {
  evaluateProductEnrichmentSchedule,
} from "./platform-automation-scheduler-due";
import { readStoreAutomationSettings } from "./platform-automation-scope-storage";
import { DEFAULT_PRODUCT_ENRICHMENT_SCHEDULE } from "./platform-automation-settings-types";
import {
  PIM_CATALOG_ENRICHMENT_DELAY_MS,
  PIM_CATALOG_ENRICHMENT_MAX_PER_RUN,
} from "./pim-catalog-enrichment-batch-request";
import { KNOWN_BAD_IMAGE_SUBSTRINGS } from "./pim-image-suspicious-policy";
import { getStagingProjectRef, supabaseUrlMatchesStagingRef } from "./staging-project-ref";
import { promoteMissingAmazonProducts } from "./amazon-product-sync-promote";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";

function envFlag(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return r.rowCount === 1;
}

async function countMissingProductsPg(
  client: pg.Client,
  organizationId: string,
  storeId: string,
): Promise<number> {
  const hasFba = await tableExists(client, "amazon_fba_inventory");
  const fbaUnion = hasFba
    ? `
    UNION
    SELECT DISTINCT UPPER(TRIM(afi.asin)) AS asin
    FROM public.amazon_fba_inventory afi
    WHERE afi.organization_id = $1::uuid AND afi.store_id = $2::uuid
      AND afi.asin IS NOT NULL AND btrim(afi.asin) <> ''
  `
    : "";

  const r = await client.query(
    `
    WITH amazon_asins AS (
      SELECT DISTINCT UPPER(TRIM(cp.asin)) AS asin
      FROM public.catalog_products cp
      WHERE cp.organization_id = $1::uuid AND cp.store_id = $2::uuid
        AND cp.asin IS NOT NULL AND btrim(cp.asin) <> ''
      ${fbaUnion}
    )
    SELECT count(*)::int AS n
    FROM amazon_asins a
    WHERE NOT EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid
        AND p.deleted_at IS NULL
        AND UPPER(TRIM(p.asin)) = a.asin
    )
  `,
    [organizationId, storeId],
  );
  return (r.rows[0] as { n: number }).n ?? 0;
}

async function countStaleProductsPg(
  client: pg.Client,
  organizationId: string,
  storeId: string,
  cutoffIso: string,
): Promise<number> {
  const r = await client.query(
    `
    SELECT count(*)::int AS n
    FROM public.products p
    WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid
      AND p.deleted_at IS NULL
      AND (p.asin IS NOT NULL AND btrim(p.asin) <> '')
      AND coalesce(p.last_catalog_sync_at, p.updated_at) < $3::timestamptz
  `,
    [organizationId, storeId, cutoffIso],
  );
  return (r.rows[0] as { n: number }).n ?? 0;
}

async function countImageSyncFailuresPg(client: pg.Client, organizationId: string): Promise<{
  missing_main_image: number;
  known_bad_image_cluster: number;
  suspicious_main_image: number;
  total: number;
}> {
  const badNeedles = KNOWN_BAD_IMAGE_SUBSTRINGS.map((s) => `%${s}%`);
  const badClauses = badNeedles.map((_, i) => `main_image_url ILIKE $${i + 2}`).join(" OR ");
  const badParams = [organizationId, ...badNeedles];

  const missing = await client.query(
    `SELECT count(*)::int AS n FROM public.products
     WHERE organization_id=$1::uuid AND deleted_at IS NULL
       AND (main_image_url IS NULL OR btrim(main_image_url)='')`,
    [organizationId],
  );

  const knownBad = await client.query(
    `SELECT count(*)::int AS n FROM public.products
     WHERE organization_id=$1::uuid AND deleted_at IS NULL
       AND main_image_url IS NOT NULL AND btrim(main_image_url) <> ''
       AND (${badClauses})`,
    badParams,
  );

  const suspicious = await client.query(
    `SELECT count(*)::int AS n FROM public.products
     WHERE organization_id=$1::uuid AND deleted_at IS NULL
       AND main_image_url IS NOT NULL AND btrim(main_image_url) <> ''
       AND amazon_raw IS NOT NULL`,
    [organizationId],
  );

  const missingN = (missing.rows[0] as { n: number }).n ?? 0;
  const knownBadN = (knownBad.rows[0] as { n: number }).n ?? 0;
  // Full suspicious evaluation requires JS — use conservative upper bound from rows with amazon_raw + image.
  const suspiciousN = Math.max(0, (suspicious.rows[0] as { n: number }).n ?? 0);

  return {
    missing_main_image: missingN,
    known_bad_image_cluster: knownBadN,
    suspicious_main_image: suspiciousN,
    total: missingN + knownBadN,
  };
}

async function cols(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

async function readSchedulerAndJobsPg(
  client: pg.Client,
  organizationId: string,
  storeId: string,
): Promise<{
  schedule: ReturnType<typeof evaluateProductEnrichmentSchedule>;
  last_job_status: string | null;
  last_job_at: string | null;
  last_successful_sync: string | null;
  cancelled_jobs_after_june: number;
  recent_jobs: Array<Record<string, unknown>>;
}> {
  let peSchedule = evaluateProductEnrichmentSchedule(DEFAULT_PRODUCT_ENRICHMENT_SCHEDULE);
  try {
    const ps = await client.query(`SELECT automation_settings FROM platform_settings WHERE id=true LIMIT 1`);
    const doc = (ps.rows[0]?.automation_settings ?? {}) as Record<string, unknown>;
    const settings = readStoreAutomationSettings(doc, organizationId, storeId);
    peSchedule = evaluateProductEnrichmentSchedule(settings.product_enrichment);
  } catch {
    /* platform_settings may be absent in some envs */
  }

  let recent_jobs: Array<Record<string, unknown>> = [];
  let last_job_status: string | null = null;
  let last_job_at: string | null = null;
  let last_successful_sync: string | null = null;
  let cancelled_jobs_after_june = 0;

  if (await tableExists(client, "background_jobs")) {
    const bgCols = await cols(client, "background_jobs");
    const timeCol = bgCols.has("completed_at")
      ? "completed_at"
      : bgCols.has("updated_at")
        ? "updated_at"
        : "created_at";
    const selectCols = [
      "id::text",
      bgCols.has("status") ? "status" : "NULL::text AS status",
      bgCols.has("created_at") ? "created_at::text" : "NULL::text AS created_at",
      bgCols.has("updated_at") ? "updated_at::text" : "NULL::text AS updated_at",
      bgCols.has("completed_at") ? "completed_at::text" : "NULL::text AS completed_at",
      bgCols.has("cancel_requested_at") ? "cancel_requested_at::text" : "NULL::text AS cancel_requested_at",
      bgCols.has("last_error_detail") ? "last_error_detail" : "NULL::text AS last_error_detail",
    ].join(", ");

    const jobs = await client.query(
      `SELECT ${selectCols}
       FROM background_jobs
       WHERE job_type='product_enrichment' AND organization_id=$1::uuid
       ORDER BY ${timeCol} DESC NULLS LAST
       LIMIT 8`,
      [organizationId],
    );
    recent_jobs = jobs.rows as Array<Record<string, unknown>>;
    const lastSuccess = jobs.rows.find((j) => (j as { status?: string }).status === "completed");
    last_successful_sync =
      (lastSuccess as { completed_at?: string } | undefined)?.completed_at ??
      (lastSuccess as { updated_at?: string } | undefined)?.updated_at ??
      null;
    if (jobs.rows[0]) {
      last_job_status = String((jobs.rows[0] as { status?: string }).status ?? "");
      last_job_at =
        (jobs.rows[0] as { completed_at?: string }).completed_at ??
        (jobs.rows[0] as { updated_at?: string }).updated_at ??
        (jobs.rows[0] as { created_at?: string }).created_at ??
        null;
    }

    if (bgCols.has("status")) {
      const cancelTimeCol = bgCols.has("completed_at")
        ? "completed_at"
        : bgCols.has("updated_at")
          ? "updated_at"
          : "created_at";
      const cancelled = await client.query(
        `SELECT count(*)::int AS n FROM background_jobs
         WHERE job_type='product_enrichment' AND organization_id=$1::uuid
           AND status IN ('cancelled','failed')
           AND ${cancelTimeCol} >= $2::timestamptz`,
        [organizationId, AMAZON_SYNC_STALE_CUTOFF_ISO],
      );
      cancelled_jobs_after_june = (cancelled.rows[0] as { n: number }).n ?? 0;
    }
  } else if (await tableExists(client, "jobs")) {
    const legacy = await client.query(
      `SELECT id::text, status, created_at::text, completed_at::text, last_error
       FROM jobs WHERE job_type='product_enrichment' AND organization_id=$1::uuid
       ORDER BY coalesce(completed_at, created_at) DESC NULLS LAST LIMIT 5`,
      [organizationId],
    );
    recent_jobs = legacy.rows as Array<Record<string, unknown>>;
    const lastSuccess = legacy.rows.find((j) => (j as { status?: string }).status === "completed");
    last_successful_sync = (lastSuccess as { completed_at?: string } | undefined)?.completed_at ?? null;
    if (legacy.rows[0]) {
      last_job_status = String((legacy.rows[0] as { status?: string }).status ?? "");
      last_job_at =
        (legacy.rows[0] as { completed_at?: string }).completed_at ??
        (legacy.rows[0] as { created_at?: string }).created_at ??
        null;
    }
  }

  const productSync = await client.query(
    `SELECT max(updated_at)::text AS max_updated_at,
            max(last_catalog_sync_at)::text AS max_last_catalog_sync_at
     FROM products WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL`,
    [organizationId, storeId],
  );
  const maxUpdated = (productSync.rows[0] as { max_updated_at?: string }).max_updated_at ?? null;
  const maxCatalog = (productSync.rows[0] as { max_last_catalog_sync_at?: string }).max_last_catalog_sync_at ?? null;

  if (!last_successful_sync) {
    last_successful_sync = maxCatalog ?? maxUpdated;
  }

  return {
    schedule: peSchedule,
    last_job_status,
    last_job_at,
    last_successful_sync,
    cancelled_jobs_after_june,
    recent_jobs,
  };
}

export async function auditAmazonProductSyncHealth(params: {
  pgClient: pg.Client;
  supabase?: SupabaseClient;
  organizationId: string;
  storeId: string;
  runId: string;
  projectRef?: string;
}): Promise<AmazonProductSyncRecoveryReport> {
  const { pgClient, organizationId, storeId, runId } = params;
  const stagingRef = params.projectRef ?? getStagingProjectRef({ loadEnv: false });
  const isStaging =
    supabaseUrlMatchesStagingRef(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", stagingRef) ||
    supabaseUrlMatchesStagingRef(process.env.STAGING_SUPABASE_URL ?? "", stagingRef);

  const root_cause_summary: string[] = [];

  const products_missing = await countMissingProductsPg(pgClient, organizationId, storeId);
  const products_stale = await countStaleProductsPg(
    pgClient,
    organizationId,
    storeId,
    AMAZON_SYNC_STALE_CUTOFF_ISO,
  );
  const image_sync_failures = await countImageSyncFailuresPg(pgClient, organizationId);
  const jobInfo = await readSchedulerAndJobsPg(pgClient, organizationId, storeId);
  const countsRow = await pgClient.query(
    `SELECT count(*)::int AS products_total,
            count(*) FILTER (WHERE amazon_raw IS NOT NULL AND updated_at >= now() - interval '30 days')::int AS updated_30d,
            max(updated_at)::text AS max_updated_at,
            max(last_catalog_sync_at)::text AS max_last_catalog_sync_at
     FROM products WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL`,
    [organizationId, storeId],
  );
  const catalogAsins = await pgClient.query(
    `SELECT count(DISTINCT UPPER(TRIM(asin)))::int AS n FROM catalog_products
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND asin IS NOT NULL AND btrim(asin)<>''`,
    [organizationId, storeId],
  );

  if (!jobInfo.schedule.schedule.enabled) {
    root_cause_summary.push("product_enrichment schedule disabled in platform_settings");
  }
  if (jobInfo.cancelled_jobs_after_june > 0) {
    root_cause_summary.push(
      `${jobInfo.cancelled_jobs_after_june} product_enrichment jobs cancelled/failed since ${AMAZON_SYNC_STALE_CUTOFF_ISO.slice(0, 10)}`,
    );
  }
  if (products_stale > 0) {
    root_cause_summary.push(
      `${products_stale} products stale (no catalog sync/update since ${AMAZON_SYNC_STALE_CUTOFF_ISO.slice(0, 10)})`,
    );
  }
  if (products_missing > 0) {
    root_cause_summary.push(
      `${products_missing} Amazon ASINs in catalog/FBA layers missing from products spine (no auto-create wired before recovery)`,
    );
  }
  root_cause_summary.push("listing_pull_worker not wired — enrichment updates existing products only");

  let api_connectivity: AmazonProductSyncRecoveryReport["api_connectivity"] = {
    ok: false,
    token_obtained: false,
    catalog_host: null,
    error: "api_probe_skipped",
  };

  try {
    const { resolveAmazonCatalogContext, getAmazonCatalogAccessToken } = await import(
      "./pim-amazon-catalog-enrichment"
    );
    const ctx = await resolveAmazonCatalogContext(organizationId, storeId);
    if (!ctx.ok) {
      api_connectivity = {
        ok: false,
        token_obtained: false,
        catalog_host: null,
        error: ctx.error,
      };
    } else {
      const token = await getAmazonCatalogAccessToken(ctx);
      if (!token.ok) {
        api_connectivity = {
          ok: false,
          token_obtained: false,
          catalog_host: ctx.catalogHost,
          error: token.error,
        };
      } else {
        api_connectivity = {
          ok: true,
          token_obtained: true,
          catalog_host: ctx.catalogHost,
          error: null,
        };
      }
    }
  } catch (e) {
    api_connectivity = {
      ok: false,
      token_obtained: false,
      catalog_host: null,
      error: e instanceof Error ? e.message : "api_probe_failed",
    };
  }

  const autoCreateEnabled = envFlag("PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED");
  const spApiEnabled = envFlag("AMAZON_SP_API_ENABLED");
  const evidenceOnly = envFlag("PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED");

  const blockers: string[] = [];
  if (!isStaging) blockers.push("catch_up_apply_staging_only");
  if (!spApiEnabled) blockers.push("AMAZON_SP_API_ENABLED_not_true");
  if (!autoCreateEnabled) blockers.push("PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED_not_true");
  if (!envFlag("PLATFORM_AUTOMATION_CONFIRM_APPLY")) {
    blockers.push("PLATFORM_AUTOMATION_CONFIRM_APPLY_not_true_for_apply");
  }
  if (process.env.NEXT_PUBLIC_SUPABASE_URL?.includes(ORIGINAL_REF)) {
    blockers.push("original_production_ref_detected");
  }

  let SAFE_FOR_ORIGINAL: AmazonProductSyncRecoveryReport["SAFE_FOR_ORIGINAL"] = "no";
  if (
    isStaging &&
    api_connectivity.ok &&
    autoCreateEnabled &&
    spApiEnabled &&
    products_missing === 0 &&
    products_stale === 0
  ) {
    SAFE_FOR_ORIGINAL = "conditional_yes";
  }

  const counts = countsRow.rows[0] as {
    products_total: number;
    updated_30d: number;
    max_updated_at: string | null;
    max_last_catalog_sync_at: string | null;
  };

  return {
    prompt: "PHASE-AMAZON-PRODUCT-SYNC-RECOVERY",
    run_id: runId,
    organization_id: organizationId,
    store_id: storeId,
    generated_at: new Date().toISOString(),
    root_cause_summary,
    last_successful_sync: jobInfo.last_successful_sync,
    products_missing,
    products_stale,
    image_sync_failures,
    scheduler_status: {
      enabled: jobInfo.schedule.schedule.enabled,
      due_now: jobInfo.schedule.schedule.due,
      reason: jobInfo.schedule.schedule.reason,
      next_run_at: jobInfo.schedule.schedule.next_run_at,
      last_job_status: jobInfo.last_job_status,
      last_job_at: jobInfo.last_job_at,
      cancelled_jobs_after_june: jobInfo.cancelled_jobs_after_june,
    },
    auto_create_status: {
      env_flag_enabled: autoCreateEnabled,
      sp_api_enabled: spApiEnabled,
      promote_implemented: true,
      evidence_only_mode: evidenceOnly,
    },
    api_connectivity,
    sync_jobs: {
      pagination_supported: true,
      rate_limit_delay_ms: PIM_CATALOG_ENRICHMENT_DELAY_MS,
      max_per_run: PIM_CATALOG_ENRICHMENT_MAX_PER_RUN,
      recent_jobs: jobInfo.recent_jobs,
    },
    upsert_path: {
      auto_update: "runPimCatalogEnrichmentBatch",
      auto_create: AMAZON_PRODUCT_SYNC_MATCH_SOURCE,
      listing_pull_worker: "not_wired",
    },
    counts: {
      products_total: counts.products_total ?? 0,
      catalog_products_distinct_asin: (catalogAsins.rows[0] as { n: number }).n ?? 0,
      products_with_amazon_raw_updated_30d: counts.updated_30d ?? 0,
      max_product_updated_at: counts.max_updated_at,
      max_last_catalog_sync_at: counts.max_last_catalog_sync_at,
    },
    catch_up_mode: {
      available: true,
      staging_only: true,
      apply_requires_confirm: true,
      blockers,
    },
    SAFE_FOR_ORIGINAL,
  };
}

export async function runAmazonProductSyncCatchUp(params: {
  pgClient: pg.Client;
  supabase: SupabaseClient;
  organizationId: string;
  storeId: string;
  runId: string;
  apply: boolean;
  promoteLimit?: number;
  enrichBatches?: number;
  enrichStartIndex?: number;
}): Promise<AmazonProductSyncCatchUpResult> {
  const report = await auditAmazonProductSyncHealth({
    pgClient: params.pgClient,
    supabase: params.supabase,
    organizationId: params.organizationId,
    storeId: params.storeId,
    runId: params.runId,
  });

  if (!params.apply) {
    return {
      ok: true,
      mode: "dry_run",
      promoted: { attempted: report.products_missing, created: 0, skipped: 0, failed: 0 },
      enriched: { batches: 0, metrics: {}, continuation: null, failures: 0 },
      report,
    };
  }

  if (report.catch_up_mode.blockers.length > 0) {
    return {
      ok: false,
      mode: "apply",
      promoted: { attempted: 0, created: 0, skipped: 0, failed: 0 },
      enriched: { batches: 0, metrics: {}, continuation: null, failures: 0 },
      report,
      error: report.catch_up_mode.blockers.join("; "),
    };
  }

  const promoteLimitRaw = params.promoteLimit ?? 50;
  const promoteResult =
    promoteLimitRaw <= 0
      ? {
          attempted: 0,
          created: 0,
          skipped: 0,
          failed: 0,
          created_product_ids: [] as string[],
          errors: [] as Array<{ asin: string; reason: string }>,
        }
      : await promoteMissingAmazonProducts({
          supabase: params.supabase,
          pgClient: params.pgClient,
          organizationId: params.organizationId,
          storeId: params.storeId,
          limit: Math.min(100, Math.max(1, promoteLimitRaw)),
          dryRun: false,
        });

  const { runPimCatalogEnrichmentBatch } = await import("./pim-catalog-enrichment-batch");
  const enrichBatches = Math.min(5, Math.max(1, params.enrichBatches ?? 1));
  let startIndex = Math.max(0, params.enrichStartIndex ?? 0);
  let continuation: { next_start_index: number; total_eligible: number } | null = null;
  const mergedMetrics: Record<string, unknown> = {};
  let failures = 0;

  for (let i = 0; i < enrichBatches; i++) {
    const batch = await runPimCatalogEnrichmentBatch({
      organizationId: params.organizationId,
      storeId: params.storeId,
      limit: PIM_CATALOG_ENRICHMENT_MAX_PER_RUN,
      startIndex,
      prioritizeIncomplete: true,
      forceFreshPriceRows: false,
      retryOnly: false,
      retryMissingPrices: false,
      retryIds: [],
      allowEnrichmentDebug: false,
      allowSuspiciousImageOverwrite: false,
    });

    if (!batch.ok) {
      return {
        ok: false,
        mode: "apply",
        promoted: promoteResult,
        enriched: { batches: i, metrics: mergedMetrics, continuation, failures },
        report: await auditAmazonProductSyncHealth({
          pgClient: params.pgClient,
          supabase: params.supabase,
          organizationId: params.organizationId,
          storeId: params.storeId,
          runId: params.runId,
        }),
        error: batch.error,
      };
    }

    for (const [k, v] of Object.entries(batch.metrics)) {
      if (typeof v === "number" && typeof mergedMetrics[k] === "number") {
        mergedMetrics[k] = (mergedMetrics[k] as number) + v;
      } else {
        mergedMetrics[k] = v;
      }
    }
    failures += batch.failures.length;
    continuation = batch.continuation ?? null;
    if (!batch.continuation) break;
    startIndex = batch.continuation.next_start_index;
  }

  const afterReport = await auditAmazonProductSyncHealth({
    pgClient: params.pgClient,
    supabase: params.supabase,
    organizationId: params.organizationId,
    storeId: params.storeId,
    runId: params.runId,
  });

  if (
    promoteResult.created > 0 &&
    afterReport.products_missing < report.products_missing &&
    afterReport.api_connectivity.ok
  ) {
    afterReport.SAFE_FOR_ORIGINAL = "conditional_yes";
  }

  return {
    ok: true,
    mode: "apply",
    promoted: promoteResult,
    enriched: {
      batches: enrichBatches,
      metrics: mergedMetrics,
      continuation,
      failures,
    },
    report: afterReport,
  };
}

export { AMAZON_PRODUCT_SYNC_MATCH_SOURCE, AMAZON_SYNC_STALE_CUTOFF_ISO };
