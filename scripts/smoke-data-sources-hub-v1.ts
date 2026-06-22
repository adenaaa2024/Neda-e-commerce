/**
 * PHASE-DATA-SOURCES-HUB-AND-CLAIM-CENTER-NAV-UNIFICATION-V1 — focused smoke (pure, no DB).
 *
 * Verifies the single Data Sources Hub contract that every status surface reads
 * from is internally consistent:
 *   - deriveDataSourceBadge covers all 8 badge states with correct precedence
 *   - badge meta exists + light/dark tones for every badge
 *   - filterDataSourcesForView (control_plane / claim / product) is consistent
 *   - missingSourceReasonsForFamily only surfaces non-ready sources
 *
 *   npx tsx scripts/smoke-data-sources-hub-v1.ts
 */
import {
  dataSourceBadgeMeta,
  deriveDataSourceBadge,
  filterDataSourcesForView,
  missingSourceReasonsForFamily,
  type DataSourceBadge,
  type DataSourceHubRow,
} from "../lib/data-sources/data-sources-hub-contract";

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    passes += 1;
  } else {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Badge derivation precedence — all 8 states reachable
// ---------------------------------------------------------------------------
const base = {
  worker_flag: "ENABLE_X" as string | null,
  enabled: false,
  live_sp_api_exists: false,
  row_count: 0 as number | null,
  freshness_status: "empty" as DataSourceHubRow["freshness_status"],
  credential_status: "present" as DataSourceHubRow["credential_status"],
  permission_status: "unknown" as DataSourceHubRow["permission_status"],
  needs_env_keys: [] as string[],
  is_control_plane_source: true,
};

check(
  deriveDataSourceBadge({ ...base, permission_status: "missing" }) === "missing_permission",
  "permission missing -> missing_permission (highest precedence)",
);
check(
  deriveDataSourceBadge({ ...base, credential_status: "missing" }) === "needs_env",
  "credential missing -> needs_env",
);
check(
  deriveDataSourceBadge({ ...base, enabled: false, row_count: 1200, freshness_status: "fresh" }) === "local_only",
  "disabled worker but local rows -> local_only",
);
check(
  deriveDataSourceBadge({ ...base, enabled: false, row_count: 0, needs_env_keys: ["ENABLE_X=true"] }) === "needs_env",
  "disabled worker + no rows + needs env -> needs_env",
);
check(
  deriveDataSourceBadge({ ...base, enabled: false, row_count: 0, needs_env_keys: [] }) === "disabled",
  "disabled worker + no rows + no env blocker -> disabled",
);
check(
  deriveDataSourceBadge({ ...base, enabled: true, live_sp_api_exists: true, row_count: 0 }) === "needs_initial_sync",
  "enabled + no rows -> needs_initial_sync",
);
check(
  deriveDataSourceBadge({
    ...base,
    enabled: true,
    live_sp_api_exists: true,
    row_count: 50,
    freshness_status: "stale",
  }) === "stale",
  "enabled + stale -> stale",
);
check(
  deriveDataSourceBadge({
    ...base,
    enabled: true,
    live_sp_api_exists: true,
    row_count: 50,
    freshness_status: "fresh",
  }) === "live",
  "enabled + fresh -> live",
);

// Non-control-plane (local/scanner/catalog) sources
check(
  deriveDataSourceBadge({ ...base, worker_flag: null, is_control_plane_source: false, row_count: 0 }) ===
    "needs_initial_sync",
  "non-worker source + no rows -> needs_initial_sync",
);
check(
  deriveDataSourceBadge({
    ...base,
    worker_flag: null,
    is_control_plane_source: false,
    row_count: 10,
    freshness_status: "stale",
  }) === "stale",
  "non-worker source + stale -> stale",
);
check(
  deriveDataSourceBadge({
    ...base,
    worker_flag: null,
    is_control_plane_source: false,
    row_count: 10,
    freshness_status: "fresh",
  }) === "healthy",
  "non-worker source + fresh -> healthy",
);

// ---------------------------------------------------------------------------
// 2. Every badge has light/dark-compatible meta
// ---------------------------------------------------------------------------
const ALL_BADGES: DataSourceBadge[] = [
  "live",
  "local_only",
  "disabled",
  "needs_env",
  "needs_initial_sync",
  "missing_permission",
  "stale",
  "healthy",
];
const VALID_TONES = new Set(["success", "info", "warning", "danger", "neutral"]);
for (const b of ALL_BADGES) {
  const meta = dataSourceBadgeMeta(b);
  check(meta.label.length > 0, `badge ${b} has a label`);
  check(VALID_TONES.has(meta.tone), `badge ${b} has a valid tone (${meta.tone})`);
}

// ---------------------------------------------------------------------------
// 3. View filtering
// ---------------------------------------------------------------------------
function row(partial: Partial<DataSourceHubRow>): DataSourceHubRow {
  return {
    source_key: "x",
    display_name: "X",
    source_domain: "claim",
    report_type_or_api_endpoint: "X",
    enabled: false,
    worker_flag: null,
    schedule: "daily",
    last_run_at: null,
    next_run_at: null,
    last_success_at: null,
    last_error: null,
    row_count: 0,
    latest_event_date: null,
    freshness_status: "empty",
    credential_status: "present",
    permission_status: "unknown",
    live_sp_api_exists: false,
    local_table: null,
    claim_family_coverage: [],
    product_story_coverage: false,
    needs_env_keys: [],
    needs_initial_sync: false,
    is_control_plane_source: true,
    badge: "disabled",
    ...partial,
  };
}

const rows: DataSourceHubRow[] = [
  row({ source_key: "settlement", source_domain: "financial" }),
  row({ source_key: "removal_order", source_domain: "removal", product_story_coverage: true }),
  row({ source_key: "inventory_ledger", source_domain: "inventory" }),
  row({ source_key: "product_identity", source_domain: "product", product_story_coverage: true, is_control_plane_source: false }),
  row({ source_key: "scanner_returns", source_domain: "scanner", product_story_coverage: true, is_control_plane_source: false }),
];

const controlPlane = filterDataSourcesForView(rows, "control_plane");
check(controlPlane.length === rows.length, "control_plane view returns all sources");

const claimView = filterDataSourcesForView(rows, "claim");
check(
  claimView.some((r) => r.source_key === "settlement") &&
    claimView.some((r) => r.source_key === "removal_order") &&
    !claimView.some((r) => r.source_key === "product_identity"),
  "claim view includes claim/financial/removal sources, excludes pure product catalog",
);

const productView = filterDataSourcesForView(rows, "product");
check(
  productView.some((r) => r.source_key === "product_identity") &&
    productView.some((r) => r.source_key === "removal_order") && // product_story_coverage true
    !productView.some((r) => r.source_key === "settlement"),
  "product view includes product-domain + product-story-contributing sources only",
);

// ---------------------------------------------------------------------------
// 4. Missing-source reasons (used by Needs Data / Ready-to-File)
// ---------------------------------------------------------------------------
const familyRows: DataSourceHubRow[] = [
  row({ source_key: "reimbursements", claim_family_coverage: ["missing_reimbursement"], badge: "needs_env" }),
  row({ source_key: "settlement", claim_family_coverage: ["missing_reimbursement"], badge: "live" }),
  row({ source_key: "ledger", claim_family_coverage: ["warehouse_lost_inventory"], badge: "stale" }),
];
const reasons = missingSourceReasonsForFamily(familyRows, "missing_reimbursement");
check(
  reasons.length === 1 && reasons[0].source_key === "reimbursements",
  "missingSourceReasons only surfaces non-ready sources for the family (live excluded)",
);
const noReasons = missingSourceReasonsForFamily(familyRows, "nonexistent_family");
check(noReasons.length === 0, "no reasons for a family with no mapped sources");

// ---------------------------------------------------------------------------
console.log(`\nData Sources Hub smoke: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
