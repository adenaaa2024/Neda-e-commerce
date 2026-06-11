export const AMAZON_PRODUCT_SYNC_MATCH_SOURCE = "amazon_product_sync_recovery";

/** Products largely stopped updating after this date (scheduler disabled / jobs cancelled). */
export const AMAZON_SYNC_STALE_CUTOFF_ISO = "2026-06-01T00:00:00.000Z";

export type AmazonProductSyncRecoveryReport = {
  prompt: "PHASE-AMAZON-PRODUCT-SYNC-RECOVERY";
  run_id: string;
  organization_id: string;
  store_id: string;
  generated_at: string;
  root_cause_summary: string[];
  last_successful_sync: string | null;
  products_missing: number;
  products_stale: number;
  image_sync_failures: {
    missing_main_image: number;
    suspicious_main_image: number;
    known_bad_image_cluster: number;
    total: number;
  };
  scheduler_status: {
    enabled: boolean;
    due_now: boolean;
    reason: string;
    next_run_at: string | null;
    last_job_status: string | null;
    last_job_at: string | null;
    cancelled_jobs_after_june: number;
  };
  auto_create_status: {
    env_flag_enabled: boolean;
    sp_api_enabled: boolean;
    promote_implemented: boolean;
    evidence_only_mode: boolean;
  };
  api_connectivity: {
    ok: boolean;
    token_obtained: boolean;
    catalog_host: string | null;
    error: string | null;
  };
  sync_jobs: {
    pagination_supported: boolean;
    rate_limit_delay_ms: number;
    max_per_run: number;
    recent_jobs: Array<Record<string, unknown>>;
  };
  upsert_path: {
    auto_update: string;
    auto_create: string;
    listing_pull_worker: string;
  };
  counts: {
    products_total: number;
    catalog_products_distinct_asin: number;
    products_with_amazon_raw_updated_30d: number;
    max_product_updated_at: string | null;
    max_last_catalog_sync_at: string | null;
  };
  catch_up_mode: {
    available: boolean;
    staging_only: boolean;
    apply_requires_confirm: boolean;
    blockers: string[];
  };
  SAFE_FOR_ORIGINAL: "no" | "conditional_yes" | "yes";
};

export type AmazonProductSyncCatchUpResult = {
  ok: boolean;
  mode: "dry_run" | "apply";
  promoted: { attempted: number; created: number; skipped: number; failed: number };
  enriched: {
    batches: number;
    metrics: Record<string, unknown>;
    continuation: { next_start_index: number; total_eligible: number } | null;
    failures: number;
  };
  report: AmazonProductSyncRecoveryReport;
  error?: string;
};
