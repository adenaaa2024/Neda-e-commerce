/** Superadmin platform automation — per org/store scope in platform_settings.automation_settings v2. */

export type AutomationRunStatus = "never" | "success" | "failed" | "running" | "partial";

export interface ManualWindowFields {
  /** YYYY-MM-DD persisted default for manual run UI */
  manual_window_start: string | null;
  manual_window_end: string | null;
}

export interface ProductEnrichmentSchedule extends ManualWindowFields {
  enabled: boolean;
  runs_per_day: number;
  run_hours_utc: number[];
}

export interface ApiAutomationCardSchedule extends ManualWindowFields {
  enabled: boolean;
  runs_per_day: number;
  run_hours_utc: number[];
  /** Rolling SP-API fetch window for scheduled runs (1–90 days). */
  rolling_days: number;
  /** Updated by scheduled cron executor (health dashboard read path). */
  cron_runtime?: RemovalCronRuntimeState;
}

export interface FinancesArchiveApiSchedule extends ApiAutomationCardSchedule {
  marketplace_id: string | null;
}

export type RemovalReportType = "removal_order" | "removal_shipment";

export interface RemovalCronRuntimeState {
  last_run_at: string | null;
  last_success_at: string | null;
  last_failed_at: string | null;
  last_run_status: AutomationRunStatus;
  last_error: string | null;
  next_run_at: string | null;
  last_slot_key: string | null;
}

export interface RemovalRecentSyncSchedule extends ManualWindowFields {
  runs_per_day: number;
  /** Legacy UTC hour slots (0–23). Used when run_times_local is empty. */
  run_hours_utc: number[];
  /** IANA timezone for scheduled local run times. */
  timezone: string;
  /** Local HH:MM slots, e.g. ["23:30"]. Preferred over run_hours_utc when non-empty. */
  run_times_local: string[];
  rolling_days: number;
  report_types: RemovalReportType[];
  rebuild_expected_packages: boolean;
  retry_on_failure: boolean;
  max_runtime_seconds: number;
}

import type { ClaimCandidateIntakePolicy } from "@/lib/claim-candidate-intake-policy";

/** Claim Discovery Engine — incremental per-source discovery into claim_candidates. */
export interface ClaimDiscoverySchedule extends ManualWindowFields {
  enabled: boolean;
  runs_per_day: number;
  run_hours_utc: number[];
  timezone: string;
  run_times_local: string[];
  /** Max lookback on first run when no per-source watermark exists. */
  initial_lookback_days: number;
  /** Overlap days when advancing watermarks (catch late-arriving source rows). */
  incremental_overlap_days: number;
  enabled_source_kinds: string[];
  purchased_source_kinds: Record<string, boolean>;
  max_runtime_seconds: number;
  scheduled_mode: "dry_run" | "apply";
  cron_runtime?: RemovalCronRuntimeState;
}

/** Phase 7D — unified claim pool generation card (claim_candidates only; never cases/lines). */
export interface ClaimPoolGenerationSchedule extends ManualWindowFields {
  enabled: boolean;
  runs_per_day: number;
  /** Legacy UTC hour slots; derived from run_times_local when present. */
  run_hours_utc: number[];
  /** IANA timezone for local run times. */
  timezone: string;
  /** Local HH:MM slots, preferred over run_hours_utc when non-empty. */
  run_times_local: string[];
  /** Rolling source window in days when no manual window set. */
  rolling_days: number;
  /** Trusted source kinds the scheduler may run (subset of registry). */
  enabled_source_kinds: string[];
  /** SaaS purchase gate per source kind; absent = purchased. */
  purchased_source_kinds: Record<string, boolean>;
  max_runtime_seconds: number;
  /** Scheduled runs write candidates only in apply mode; dry_run logs counts. */
  scheduled_mode: "dry_run" | "apply";
  /** Updated by scheduler/manual runs (status card read path). */
  cron_runtime?: RemovalCronRuntimeState;
}

export interface RemovalHistoricalBackfillSchedule {
  enabled: boolean;
  runs_per_week: number;
  run_day_of_week: number;
  run_hour_utc: number;
  window_keys: string[];
}

export interface RemovalApiSyncSchedule {
  enabled: boolean;
  recent_sync: RemovalRecentSyncSchedule;
  historical_backfill: RemovalHistoricalBackfillSchedule;
  /** Updated by production Vercel cron (read-path for health dashboard). */
  cron_runtime?: RemovalCronRuntimeState;
}

/** Full settings for one organization + store scope. */
export interface StoreAutomationSettings {
  product_enrichment: ProductEnrichmentSchedule;
  removal_api_sync: RemovalApiSyncSchedule;
  reimbursements_api: ApiAutomationCardSchedule;
  settlement_api: ApiAutomationCardSchedule;
  finances_archive_api: FinancesArchiveApiSchedule;
  claim_pool_generation: ClaimPoolGenerationSchedule;
  claim_discovery: ClaimDiscoverySchedule;
  /** Optional store-level candidate intake override (Phase 7E). Null = inherit company. */
  claim_candidate_intake: ClaimCandidateIntakePolicy | null;
  /** Live-source sync workers (PHASE-AMAZON-LIVE-REPORTS-FINANCES-SYNC-WORKERS-V1). Optional for backward compat with stored settings. */
  fba_returns_api?: ApiAutomationCardSchedule;
  inventory_ledger_api?: ApiAutomationCardSchedule;
  fee_preview_api?: ApiAutomationCardSchedule;
  inbound_performance_api?: ApiAutomationCardSchedule;
}

/** v2 persisted document shape. */
export interface PlatformAutomationPersisted {
  version: 2;
  scopes: Record<string, StoreAutomationSettings>;
}

/** Legacy flat shape (scheduler compat). */
export interface PlatformAutomationSettings {
  product_enrichment: ProductEnrichmentSchedule;
  removal_api_sync: RemovalApiSyncSchedule;
}

export interface AutomationScheduleRuntime {
  last_run_at: string | null;
  last_run_status: AutomationRunStatus;
  last_error: string | null;
  next_run_at: string | null;
}

export interface PlatformAutomationApiFlags {
  reports_worker_enabled: boolean;
  reimbursements_enabled: boolean;
  settlement_enabled: boolean;
  removal_order_enabled: boolean;
  removal_shipment_enabled: boolean;
  finances_worker_enabled: boolean;
  finances_ingest_enabled: boolean;
  fba_returns_enabled: boolean;
  inventory_ledger_enabled: boolean;
  fee_preview_enabled: boolean;
  inbound_performance_enabled: boolean;
}

/** Client-safe run environment hints (no secrets). */
export type AutomationRunEnvironment = {
  reports_api_worker_enabled: boolean;
  production_db_configured: boolean;
  cron_secret_configured: boolean;
  original_postgres_configured: boolean;
  vercel_cron_tier: "hobby" | "pro";
  manual_run_may_queue_only: boolean;
  local_warning: string | null;
};

/** Latest manual/import run handles for resume (no credentials). */
export interface AutomationCardManualRunState {
  upload_id: string | null;
  source_run_id: string | null;
  needs_resume: boolean;
  state: string | null;
  last_error: string | null;
  /** product_enrichment only — background_jobs.id */
  active_job_id: string | null;
  job_status: string | null;
}

export const EMPTY_MANUAL_RUN_STATE: AutomationCardManualRunState = {
  upload_id: null,
  source_run_id: null,
  needs_resume: false,
  state: null,
  last_error: null,
  active_job_id: null,
  job_status: null,
};

export interface StoreAutomationSettingsView extends StoreAutomationSettings {
  organization_id: string;
  store_id: string;
  updated_at: string | null;
  manual_runs: {
    product_enrichment: AutomationCardManualRunState;
    reimbursements_api: AutomationCardManualRunState;
    settlement_api: AutomationCardManualRunState;
    finances_archive_api: AutomationCardManualRunState;
    removal_order: AutomationCardManualRunState;
    removal_shipment: AutomationCardManualRunState;
  };
  runtime: {
    product_enrichment: AutomationScheduleRuntime;
    removal_api_sync: {
      recent: AutomationScheduleRuntime;
      historical_backfill: AutomationScheduleRuntime;
    };
    reimbursements_api: AutomationScheduleRuntime;
    settlement_api: AutomationScheduleRuntime;
    finances_archive_api: AutomationScheduleRuntime;
  };
  api_flags: PlatformAutomationApiFlags;
}

export const EMPTY_MANUAL_RUNS: StoreAutomationSettingsView["manual_runs"] = {
  product_enrichment: { ...EMPTY_MANUAL_RUN_STATE },
  reimbursements_api: { ...EMPTY_MANUAL_RUN_STATE },
  settlement_api: { ...EMPTY_MANUAL_RUN_STATE },
  finances_archive_api: { ...EMPTY_MANUAL_RUN_STATE },
  removal_order: { ...EMPTY_MANUAL_RUN_STATE },
  removal_shipment: { ...EMPTY_MANUAL_RUN_STATE },
};

/** @deprecated Use StoreAutomationSettingsView — kept for script compat */
export interface PlatformAutomationSettingsView extends PlatformAutomationSettings {
  runtime: StoreAutomationSettingsView["runtime"];
  updated_at: string | null;
}

export const DEFAULT_MANUAL_WINDOW: ManualWindowFields = {
  manual_window_start: null,
  manual_window_end: null,
};

export const DEFAULT_PRODUCT_ENRICHMENT_SCHEDULE: ProductEnrichmentSchedule = {
  enabled: false,
  runs_per_day: 1,
  run_hours_utc: [6],
  ...DEFAULT_MANUAL_WINDOW,
};

export const DEFAULT_API_CARD_SCHEDULE: ApiAutomationCardSchedule = {
  enabled: false,
  runs_per_day: 1,
  run_hours_utc: [6],
  rolling_days: 30,
  ...DEFAULT_MANUAL_WINDOW,
};

export const DEFAULT_FINANCES_ARCHIVE_SCHEDULE: FinancesArchiveApiSchedule = {
  ...DEFAULT_API_CARD_SCHEDULE,
  marketplace_id: null,
};

export const DEFAULT_REMOVAL_RECENT_SYNC: RemovalRecentSyncSchedule = {
  runs_per_day: 1,
  run_hours_utc: [6],
  timezone: "America/Los_Angeles",
  run_times_local: ["23:30"],
  rolling_days: 7,
  report_types: ["removal_order", "removal_shipment"],
  rebuild_expected_packages: true,
  retry_on_failure: true,
  max_runtime_seconds: 1800,
  ...DEFAULT_MANUAL_WINDOW,
};

export const EMPTY_REMOVAL_CRON_RUNTIME: RemovalCronRuntimeState = {
  last_run_at: null,
  last_success_at: null,
  last_failed_at: null,
  last_run_status: "never",
  last_error: null,
  next_run_at: null,
  last_slot_key: null,
};

export const DEFAULT_REMOVAL_HISTORICAL_BACKFILL: RemovalHistoricalBackfillSchedule = {
  enabled: false,
  runs_per_week: 1,
  run_day_of_week: 0,
  run_hour_utc: 4,
  window_keys: ["nov_2025_w1"],
};

export const DEFAULT_REMOVAL_API_SYNC_SCHEDULE: RemovalApiSyncSchedule = {
  enabled: false,
  recent_sync: DEFAULT_REMOVAL_RECENT_SYNC,
  historical_backfill: DEFAULT_REMOVAL_HISTORICAL_BACKFILL,
};

export const CLAIM_POOL_SOURCE_KINDS = [
  "scanner_physical_review",
  "amazon_removal_api",
  "reimbursement",
  "settlement",
  "transaction",
  "inventory_ledger",
  "safet",
  "delayed_not_received",
  "shipment_discrepancy",
  "inbound_shipment",
  "manual_import",
  "orbit_fra",
] as const;

export const CLAIM_DISCOVERY_SOURCE_KINDS = [
  "reimbursement",
  "transaction",
  "inventory_ledger",
  "safet",
  "delayed_not_received",
  "shipment_discrepancy",
  "amazon_removal_api",
  "inbound_shipment",
  "scanner_physical_review",
] as const;

export const DEFAULT_CLAIM_DISCOVERY_SCHEDULE: ClaimDiscoverySchedule = {
  enabled: false,
  runs_per_day: 1,
  run_hours_utc: [11],
  timezone: "America/Los_Angeles",
  run_times_local: ["03:00"],
  initial_lookback_days: 7,
  incremental_overlap_days: 1,
  enabled_source_kinds: [...CLAIM_DISCOVERY_SOURCE_KINDS],
  purchased_source_kinds: {},
  max_runtime_seconds: 900,
  scheduled_mode: "dry_run",
  ...DEFAULT_MANUAL_WINDOW,
};

export const DEFAULT_CLAIM_POOL_GENERATION_SCHEDULE: ClaimPoolGenerationSchedule = {
  enabled: false,
  runs_per_day: 1,
  run_hours_utc: [10],
  timezone: "America/Los_Angeles",
  run_times_local: ["02:30"],
  rolling_days: 90,
  enabled_source_kinds: [...CLAIM_POOL_SOURCE_KINDS],
  purchased_source_kinds: {},
  max_runtime_seconds: 900,
  scheduled_mode: "dry_run",
  ...DEFAULT_MANUAL_WINDOW,
};

export const DEFAULT_STORE_AUTOMATION_SETTINGS: StoreAutomationSettings = {
  product_enrichment: DEFAULT_PRODUCT_ENRICHMENT_SCHEDULE,
  removal_api_sync: DEFAULT_REMOVAL_API_SYNC_SCHEDULE,
  reimbursements_api: { ...DEFAULT_API_CARD_SCHEDULE },
  settlement_api: { ...DEFAULT_API_CARD_SCHEDULE, run_hours_utc: [7] },
  finances_archive_api: { ...DEFAULT_FINANCES_ARCHIVE_SCHEDULE },
  claim_pool_generation: { ...DEFAULT_CLAIM_POOL_GENERATION_SCHEDULE },
  claim_discovery: { ...DEFAULT_CLAIM_DISCOVERY_SCHEDULE },
  claim_candidate_intake: null,
  fba_returns_api: { ...DEFAULT_API_CARD_SCHEDULE, run_hours_utc: [8] },
  inventory_ledger_api: { ...DEFAULT_API_CARD_SCHEDULE, run_hours_utc: [9] },
  fee_preview_api: { ...DEFAULT_API_CARD_SCHEDULE, run_hours_utc: [10] },
  inbound_performance_api: { ...DEFAULT_API_CARD_SCHEDULE, run_hours_utc: [11] },
};

export const DEFAULT_PLATFORM_AUTOMATION_SETTINGS: PlatformAutomationSettings = {
  product_enrichment: DEFAULT_PRODUCT_ENRICHMENT_SCHEDULE,
  removal_api_sync: DEFAULT_REMOVAL_API_SYNC_SCHEDULE,
};

export const EMPTY_AUTOMATION_RUNTIME: AutomationScheduleRuntime = {
  last_run_at: null,
  last_run_status: "never",
  last_error: null,
  next_run_at: null,
};

export type AutomationApiCardId =
  | "product_enrichment"
  | "removal_api_sync"
  | "reimbursements_api"
  | "settlement_api"
  | "finances_archive_api"
  | "historical_backfill"
  | "claim_pool_generation"
  | "claim_discovery"
  | "fba_returns_api"
  | "inventory_ledger_api"
  | "fee_preview_api"
  | "inbound_performance_api";
