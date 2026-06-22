/**
 * PHASE-DATA-SOURCES-HUB-AND-CLAIM-CENTER-NAV-UNIFICATION-V1
 *
 * CLIENT-SAFE contract for the single Data Sources Hub. This module is FULLY
 * self-contained (ZERO imports — not even `import type`) so it can be imported
 * by client components without dragging server-only code (supabase, worker
 * flags, report registry) into the browser bundle. Same boundary law as
 * `claim-source-coverage-ui-contract.ts`.
 *
 * One hub, many filtered views:
 *   - Platform Settings / Data Sources  = control plane (all sources)
 *   - Claim Center / Sources            = claim-filtered view of the same hub
 *   - Product Story / Sources           = product-filtered view of the same hub
 *   - Ready-to-File / Needs Data        = read missing-source reasons from the hub
 */

export const DATA_SOURCES_HUB_V1 = "data-sources-hub-v1";

/** Logical domain a source belongs to (drives the filtered views). */
export type DataSourceDomain =
  | "product"
  | "claim"
  | "removal"
  | "financial"
  | "inventory"
  | "return"
  | "fee"
  | "inbound"
  | "scanner";

/** Per-source freshness (live data age vs cadence). Mirrors sync-foundation. */
export type DataSourceFreshness = "fresh" | "stale" | "empty" | "no_worker" | "unknown";

/** SP-API credential presence (never the secret itself). */
export type DataSourceCredentialStatus = "present" | "missing" | "not_required" | "unknown";

/** Report-type permission (cannot be verified without an Amazon call — default unknown). */
export type DataSourcePermissionStatus = "ok" | "missing" | "unknown";

/**
 * The single normalized status badge every UI surface must render. Derived from
 * the row by {@link deriveDataSourceBadge} so all views agree on the label.
 */
export type DataSourceBadge =
  | "live" // worker enabled + fresh data
  | "local_only" // local/file data exists but live SP-API sync disabled
  | "disabled" // worker/flag off and no local data
  | "needs_env" // env flag / credential missing
  | "needs_initial_sync" // enabled but no rows yet
  | "missing_permission" // SP-API report permission missing
  | "stale" // enabled + data exists but older than cadence
  | "healthy"; // non-worker source with current local data

export type DataSourceHubRow = {
  source_key: string;
  display_name: string;
  source_domain: DataSourceDomain;
  report_type_or_api_endpoint: string;
  enabled: boolean;
  worker_flag: string | null;
  schedule: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  row_count: number | null;
  latest_event_date: string | null;
  freshness_status: DataSourceFreshness;
  credential_status: DataSourceCredentialStatus;
  permission_status: DataSourcePermissionStatus;
  live_sp_api_exists: boolean;
  local_table: string | null;
  claim_family_coverage: string[];
  product_story_coverage: boolean;
  needs_env_keys: string[];
  needs_initial_sync: boolean;
  is_control_plane_source: boolean;
  /** Normalized badge (also computed server-side; recompute client-side is safe). */
  badge: DataSourceBadge;
};

export type DataSourcesHubTotals = {
  total_sources: number;
  live: number;
  local_only: number;
  disabled: number;
  needs_env: number;
  needs_initial_sync: number;
  stale: number;
  healthy: number;
  missing_permission: number;
};

export type DataSourcesHubPayload = {
  version: string;
  generated_at: string;
  organization_id: string;
  store_id: string | null;
  /** Which filtered view produced this payload. */
  view: DataSourcesHubView;
  sources: DataSourceHubRow[];
  totals: DataSourcesHubTotals;
  /** Env keys that must be set before any live source sync is safe. */
  missing_env_keys: string[];
  cron_secret_present: boolean;
  worker_master_enabled: boolean;
  /** No env blockers AND credentials present. */
  safe_to_run_initial_live_source_sync: boolean;
};

export type DataSourcesHubView = "control_plane" | "claim" | "product";

/**
 * Single source of truth for the status badge. Pure + deterministic so every
 * surface (settings, claim coverage, ready-to-file, reimbursement, product
 * story) renders the same label for a given source.
 */
export function deriveDataSourceBadge(row: {
  worker_flag: string | null;
  enabled: boolean;
  live_sp_api_exists: boolean;
  row_count: number | null;
  freshness_status: DataSourceFreshness;
  credential_status: DataSourceCredentialStatus;
  permission_status: DataSourcePermissionStatus;
  needs_env_keys: string[];
  is_control_plane_source: boolean;
}): DataSourceBadge {
  const rows = row.row_count ?? 0;

  // Non-worker / local sources (scanner, catalog) never report a worker flag.
  if (!row.is_control_plane_source) {
    if (rows === 0) return "needs_initial_sync";
    if (row.freshness_status === "stale") return "stale";
    return "healthy";
  }

  if (row.permission_status === "missing") return "missing_permission";
  if (row.credential_status === "missing") return "needs_env";

  if (!row.enabled || !row.live_sp_api_exists) {
    // Live sync off — but a file importer may have loaded local rows.
    if (rows > 0) return "local_only";
    if (row.needs_env_keys.length > 0) return "needs_env";
    return "disabled";
  }

  // Live sync enabled from here.
  if (rows === 0) return "needs_initial_sync";
  if (row.freshness_status === "stale") return "stale";
  return "live";
}

const BADGE_META: Record<DataSourceBadge, { label: string; tone: string }> = {
  live: { label: "Live", tone: "success" },
  healthy: { label: "Healthy", tone: "success" },
  local_only: { label: "Local only", tone: "info" },
  disabled: { label: "Disabled", tone: "neutral" },
  needs_env: { label: "Needs env", tone: "warning" },
  needs_initial_sync: { label: "Needs initial sync", tone: "warning" },
  missing_permission: { label: "Missing permission", tone: "danger" },
  stale: { label: "Stale", tone: "warning" },
};

export function dataSourceBadgeMeta(badge: DataSourceBadge): { label: string; tone: string } {
  return BADGE_META[badge];
}

/** Domains surfaced to a given filtered view. Empty = all (control plane). */
const VIEW_DOMAINS: Record<DataSourcesHubView, DataSourceDomain[] | null> = {
  control_plane: null,
  claim: ["claim", "removal", "financial", "inventory", "return", "fee", "inbound", "scanner"],
  product: ["product", "scanner", "return", "removal"],
};

/** Filter hub rows for a filtered view (claim/product). Control plane = all. */
export function filterDataSourcesForView(
  rows: DataSourceHubRow[],
  view: DataSourcesHubView,
): DataSourceHubRow[] {
  const domains = VIEW_DOMAINS[view];
  if (!domains) return rows;
  if (view === "product") {
    // Product Story view = product-domain sources + anything that feeds product story.
    return rows.filter((r) => domains.includes(r.source_domain) || r.product_story_coverage);
  }
  return rows.filter((r) => domains.includes(r.source_domain));
}

/** Human-readable missing-source reason for a claim family (used by Needs Data / Ready-to-File). */
export function missingSourceReasonsForFamily(
  rows: DataSourceHubRow[],
  familyKey: string,
): Array<{ source_key: string; display_name: string; badge: DataSourceBadge; reason: string }> {
  const out: Array<{ source_key: string; display_name: string; badge: DataSourceBadge; reason: string }> = [];
  for (const r of rows) {
    if (!r.claim_family_coverage.includes(familyKey) && !r.claim_family_coverage.includes("ALL")) continue;
    if (r.badge === "live" || r.badge === "healthy" || r.badge === "local_only") continue;
    const meta = BADGE_META[r.badge];
    out.push({
      source_key: r.source_key,
      display_name: r.display_name,
      badge: r.badge,
      reason: `${r.display_name}: ${meta.label}`,
    });
  }
  return out;
}
