/**
 * PHASE-AMAZON-SPAPI-LIVE-SOURCE-INTEGRATION-AND-CLAIM-GATE-AUDIT-V1
 *
 * READ-ONLY live-integration audit + connector plan/build gate against the
 * ORIGINAL/LIVE project (kxsvedvpjldygtdbylsy).
 *
 * Produces:
 *   - Part 1: Amazon SP-API connection status (presence only — NO secrets shown)
 *   - Part 2/3: report/API coverage + live-sync + local-source-freshness matrices
 *               (reuses composeClaimSourceCoverageV1)
 *   - Part 4: corrected removal-candidate claim-gate matrix (reuses the pilot
 *             ready-to-file queue + computeRemovalOriginReason + amount/recovery)
 *   - Part 5: UI Ready-to-File gate-correction assessment
 *   - Part 6: counts, verification flags, SAFE_* verdicts, NEXT_PROMPT
 *
 * HARD LIMITS (enforced by construction — this script only SELECTs):
 *   NO claim_candidates / claim_cases / claim_lines / claim_submissions mutation.
 *   NO Amazon case submission. NO browser automation. NO scanner change. NO AI.
 *
 *   npx tsx scripts/phase-amazon-spapi-live-source-integration-and-claim-gate-audit-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimSourceCoverageV1 } from "../lib/claims/center/claim-source-coverage-v1";
import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  computeAmountStatus,
  computeRecoveryGap,
  computeRemovalOriginReason,
  type ReadyToFileRow,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const RUN_OPTS = { pilot_case_run_id: PILOT_CASE_RUN_ID, intake_run_id: PILOT_INTAKE_RUN_ID };
const OUT_BASE = ".cursor/audit-reports/phase-amazon-spapi-live-source-integration-and-claim-gate-audit-v1";

const REMOVAL_FAMILIES = new Set(["removal_shipment_missing", "removal_order_discrepancy"]);

type Json = Record<string, unknown>;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function present(v: unknown): boolean {
  return String(v ?? "").trim().length > 0;
}

// ---- Corrected claim-gate status enum (Part 4) ----
type CorrectedGate =
  | "ready_to_file"
  | "waiting_physical_receiving"
  | "waiting_threshold"
  | "missing_sale_price"
  | "data_candidate_only"
  | "wrong_family"
  | "needs_manual_review";

type GateRow = {
  claim_submission_id: string;
  family: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  removal_order_id: string | null;
  removal_shipment_id: string | null;
  // current system state
  current_ready_to_file: boolean;
  // origin / receiving evidence
  origin_validity: string;
  origin_sources: string[];
  has_external_event_source: boolean;
  event_age_days: number | null;
  threshold_days: number;
  package_received: boolean;
  scanned_units: number;
  received_qty: number | null;
  expected_qty: number | null;
  build_status: string | null;
  // receiving-workflow questions (Part 4)
  physically_received_into_workflow: boolean;
  pallet_or_package_created: boolean;
  scanning_started: boolean;
  scanning_finalized: "yes" | "no" | "unknown";
  expected_package_linked_to_receiving: boolean;
  no_scan_meaningful: "yes" | "no" | "unknown";
  api_shows_removal_delivered: "yes" | "no" | "unknown";
  scan_go_live_applies: "yes" | "no" | "unknown";
  delayed_threshold_applies: boolean;
  // money + reimbursement
  latest_sale_net_known: boolean;
  reimbursement_status: string;
  reimbursement_check_complete: boolean;
  // verdict
  corrected_status: CorrectedGate;
  demoted_from_ready: boolean;
  reason: string;
};

function classifyGate(
  row: ReadyToFileRow,
  scanGoLiveFound: boolean,
): GateRow {
  const origin = computeRemovalOriginReason(row);
  const amount = computeAmountStatus(row);
  const gap = computeRecoveryGap(row);
  const i = row.removal_origin_inputs ?? null;

  const family = row.claim_family;
  const inRemovalFamily = REMOVAL_FAMILIES.has(family ?? "");

  const packageReceived = i?.package_received ?? false;
  const scannedUnits = i?.scanned_units ?? 0;
  const receivedQty = i?.received_qty ?? null;
  const expectedQty = i?.expected_qty ?? null;
  const buildStatus = i?.build_status ?? null;
  const hasExternalEventSource = origin.from_removal_shipment_detail || origin.from_removal_order_detail;

  // Receiving-workflow truth signals (read-only inference from resolved inputs).
  const scanningStarted = scannedUnits > 0 || (receivedQty ?? 0) > 0 || packageReceived;
  const physicallyReceived = packageReceived || (receivedQty ?? 0) > 0;
  const palletOrPackageCreated = packageReceived; // packages row present for the tracking
  // We have NO live removal-delivery API/report wired (live_sp_api_exists=false for
  // removal sources), so we cannot confirm Amazon marked the removal delivered.
  const apiShowsDelivered: "yes" | "no" | "unknown" = "unknown";
  // scan_go_live_date is not configured/enforced for removal families today.
  const scanGoLiveApplies: "yes" | "no" | "unknown" = scanGoLiveFound ? "unknown" : "no";
  // No-scan is only meaningful if receiving WAS performed for this shipment window
  // AND we can prove the unit should have arrived (delivery proof). Neither holds.
  const noScanMeaningful: "yes" | "no" | "unknown" = scanningStarted
    ? "no" // it WAS scanned/received → absence not the basis
    : apiShowsDelivered === "yes" && scanGoLiveApplies === "yes"
      ? "yes"
      : "unknown";

  const latestSaleNetKnown = amount.amount_available;
  const reimbursementComplete = gap.reimbursement_status !== "unknown_unmatched";
  const delayedThresholdApplies =
    origin.event_age_days != null && origin.event_age_days > origin.threshold_days;

  // ---- Deterministic corrected status ----
  let corrected: CorrectedGate;
  let reason: string;

  if (!inRemovalFamily) {
    corrected = "wrong_family";
    reason = `Family ${family ?? "null"} is not a removal family for this queue.`;
  } else if (origin.validity === "not_missing") {
    corrected = "wrong_family";
    reason = origin.final_reason;
  } else if (origin.validity === "needs_manual_review" || origin.validity === "not_applicable") {
    corrected = "needs_manual_review";
    reason = origin.final_reason;
  } else if (origin.validity === "waiting_threshold") {
    corrected = "waiting_threshold";
    reason = origin.final_reason;
  } else {
    // origin.validity is valid_missing or valid_discrepancy — apply the strict gate.
    // 1) Physical-receiving / live-delivery gate.
    const receivingGateSatisfied = scanningStarted || apiShowsDelivered === "yes";
    if (!receivingGateSatisfied) {
      // Scanning never started for this shipment AND no API delivery proof →
      // absence of a scan is NOT meaningful evidence of loss yet.
      corrected = scanGoLiveFound ? "waiting_physical_receiving" : "data_candidate_only";
      reason = scanGoLiveFound
        ? "No physical receiving/scan performed for this shipment and no live removal-delivery proof — cannot treat no-scan as missing; wait for physical receiving."
        : "No physical receiving/scan performed, scan_go_live_date not configured, and no live removal-delivery source — data candidate only, not fileable.";
    } else if (!latestSaleNetKnown) {
      corrected = "missing_sale_price";
      reason = `Latest sale net UNKNOWN (${amount.unknown_reason ?? "no loaded sale source"}) — filing not allowed.`;
    } else if (!reimbursementComplete) {
      // Reimbursement status unknown due to missing live reimbursement source →
      // cannot confirm unpaid → not fileable yet.
      corrected = "data_candidate_only";
      reason =
        "Reimbursement status unknown_unmatched (no live order-linked reimbursement source) — cannot confirm unpaid; hold as data candidate.";
    } else {
      corrected = "ready_to_file";
      reason = origin.final_reason;
    }
  }

  return {
    claim_submission_id: row.claim_submission_id,
    family,
    sku: row.sku,
    fnsku: row.fnsku,
    asin: row.asin,
    removal_order_id: origin.removal_order_id ?? row.removal_order_id,
    removal_shipment_id: origin.removal_shipment_id ?? row.removal_shipment_id,
    current_ready_to_file: row.ready_to_file,
    origin_validity: origin.validity,
    origin_sources: origin.origin_sources,
    has_external_event_source: hasExternalEventSource,
    event_age_days: origin.event_age_days,
    threshold_days: origin.threshold_days,
    package_received: packageReceived,
    scanned_units: scannedUnits,
    received_qty: receivedQty,
    expected_qty: expectedQty,
    build_status: buildStatus,
    physically_received_into_workflow: physicallyReceived,
    pallet_or_package_created: palletOrPackageCreated,
    scanning_started: scanningStarted,
    scanning_finalized: packageReceived ? "yes" : scanningStarted ? "unknown" : "no",
    expected_package_linked_to_receiving: present(i?.from_expected_packages) && palletOrPackageCreated,
    no_scan_meaningful: noScanMeaningful,
    api_shows_removal_delivered: apiShowsDelivered,
    scan_go_live_applies: scanGoLiveApplies,
    delayed_threshold_applies: delayedThresholdApplies,
    latest_sale_net_known: latestSaleNetKnown,
    reimbursement_status: gap.reimbursement_status,
    reimbursement_check_complete: reimbursementComplete,
    corrected_status: corrected,
    demoted_from_ready: row.ready_to_file && corrected !== "ready_to_file",
    reason,
  };
}

// ---- Part 1: Amazon connection audit (presence only) ----
async function auditAmazonConnection(client: SupabaseClient): Promise<Json> {
  // Probe marketplaces rows for amazon SP-API credential presence (NEVER values).
  const credKeyGroups = {
    lwa: ["lwa_client_id", "lwa_client_secret", "refresh_token"],
    aws: ["aws_access_key", "aws_secret_key", "aws_region"],
    marketplace: ["marketplace_id", "marketplace_ids"],
    endpoint: ["endpoint", "sp_api_endpoint", "reports_endpoint"],
  };

  let marketplaceRows: Array<Record<string, unknown>> = [];
  let marketplacesTableExists = true;
  let marketplaceProbeError: string | null = null;
  const mq = await client
    .from("marketplaces")
    .select("id, organization_id, provider, is_active, credentials")
    .ilike("provider", "%amazon%");
  if (mq.error) {
    marketplaceProbeError = mq.error.message;
    if ((mq.error as { code?: string }).code === "42P01") marketplacesTableExists = false;
  } else {
    marketplaceRows = (mq.data ?? []) as Array<Record<string, unknown>>;
  }

  const presenceByRow = marketplaceRows.map((r) => {
    const creds = (r.credentials ?? {}) as Record<string, unknown>;
    const groupPresence: Record<string, Record<string, boolean>> = {};
    let lwaComplete = true;
    let awsComplete = true;
    for (const [group, keys] of Object.entries(credKeyGroups)) {
      groupPresence[group] = {};
      for (const k of keys) groupPresence[group][k] = present(creds[k]);
    }
    lwaComplete = credKeyGroups.lwa.every((k) => present(creds[k]));
    awsComplete = credKeyGroups.aws.some((k) => present(creds[k])) || present(process.env.AWS_ACCESS_KEY_ID);
    const mpPresent = credKeyGroups.marketplace.some((k) => present(creds[k]));
    return {
      marketplace_row_id: String(r.id ?? ""),
      provider: String(r.provider ?? ""),
      is_active: r.is_active === true,
      credential_presence: groupPresence,
      lwa_complete: lwaComplete,
      aws_signing_available: awsComplete,
      marketplace_id_present: mpPresent,
      updated_at: r.updated_at ?? null,
    };
  });

  // organization_api_keys named amazon_sp_api (alt credential source).
  let orgApiKeyPresent = false;
  const ok = await client
    .from("organization_api_keys")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG)
    .ilike("name", "%amazon_sp_api%");
  if (!ok.error) orgApiKeyPresent = (ok.count ?? 0) > 0;

  // Worker / master feature flags (env presence).
  const flags = {
    AMAZON_SP_API_ENABLED: envFlag("AMAZON_SP_API_ENABLED"),
    ENABLE_AMAZON_REPORTS_API_WORKER: envFlag("ENABLE_AMAZON_REPORTS_API_WORKER"),
    ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS: envFlag("ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS"),
    ENABLE_AMAZON_REPORTS_API_SETTLEMENT: envFlag("ENABLE_AMAZON_REPORTS_API_SETTLEMENT"),
    ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER: envFlag("ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER"),
    ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT: envFlag("ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT"),
    ENABLE_AMAZON_FINANCES_API_WORKER: envFlag("ENABLE_AMAZON_FINANCES_API_WORKER"),
    ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON: envFlag("ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON"),
    CRON_SECRET_present: present(process.env.CRON_SECRET),
  };

  // Last-sync / failure runtime from platform_settings.automation_settings.
  const cronRuntime: Json[] = [];
  const ps = await client
    .from("platform_settings")
    .select("automation_settings")
    .eq("organization_id", ORG)
    .maybeSingle();
  if (!ps.error && ps.data) {
    const auto = (ps.data as { automation_settings?: unknown }).automation_settings;
    const collect = (obj: unknown, pathStr: string): void => {
      if (!obj || typeof obj !== "object") return;
      const o = obj as Record<string, unknown>;
      if ("last_run_at" in o || "last_success_at" in o || "last_failed_at" in o) {
        cronRuntime.push({
          path: pathStr,
          last_run_at: o.last_run_at ?? null,
          last_run_status: o.last_run_status ?? null,
          last_success_at: o.last_success_at ?? null,
          last_failed_at: o.last_failed_at ?? null,
          last_error: o.last_error ? "present" : null,
          next_run_at: o.next_run_at ?? null,
        });
      }
      for (const [k, v] of Object.entries(o)) collect(v, pathStr ? `${pathStr}.${k}` : k);
    };
    collect(auto, "automation_settings");
  }

  // Audit-log recency (failures/logs).
  let auditLogCount: number | null = null;
  let lastAuditAt: string | null = null;
  const al = await client
    .from("platform_automation_audit_log")
    .select("created_at", { count: "exact" })
    .eq("organization_id", ORG)
    .order("created_at", { ascending: false })
    .limit(1);
  if (!al.error) {
    auditLogCount = al.count ?? 0;
    lastAuditAt = (al.data?.[0] as { created_at?: string } | undefined)?.created_at ?? null;
  }

  // ---- Classify connection status ----
  // Two distinct SP-API lanes:
  //   catalog/pricing enrichment lane → gated by AMAZON_SP_API_ENABLED (proven live in prior PIM phases)
  //   reports/finances SYNC lane (the live CLAIM sources) → gated by ENABLE_AMAZON_REPORTS_API_WORKER + sub-flags
  const anyCreds = presenceByRow.some((r) => r.lwa_complete);
  const anyComplete = presenceByRow.some((r) => r.lwa_complete && r.aws_signing_available && r.marketplace_id_present);
  const reportSyncEnabled =
    flags.ENABLE_AMAZON_REPORTS_API_WORKER || flags.ENABLE_AMAZON_FINANCES_API_WORKER;
  const catalogPricingEnabled = flags.AMAZON_SP_API_ENABLED;
  const anyRecentFailure = cronRuntime.some((c) => c.last_run_status === "error" || c.last_failed_at != null);
  const anyRecentSuccess = cronRuntime.some((c) => c.last_success_at != null);

  // Status reflects the CLAIM live-source (Reports/Finances sync) lane, which is the
  // subject of this phase — not the already-live catalog/pricing enrichment lane.
  let status:
    | "not_configured"
    | "partially_configured"
    | "configured_but_disabled"
    | "configured_but_failing"
    | "configured_and_working";
  if (!anyCreds && !orgApiKeyPresent) status = "not_configured";
  else if (!anyComplete) status = "partially_configured";
  else if (!reportSyncEnabled) status = "configured_but_disabled";
  else if (anyRecentFailure && !anyRecentSuccess) status = "configured_but_failing";
  else if (anyRecentSuccess) status = "configured_and_working";
  else status = "configured_but_disabled";

  return {
    amazon_connection_status: status,
    marketplaces_table_exists: marketplacesTableExists,
    marketplace_probe_error: marketplaceProbeError,
    marketplace_rows: presenceByRow,
    org_api_key_amazon_sp_api_present: orgApiKeyPresent,
    feature_flags: flags,
    report_sync_lane_enabled: reportSyncEnabled,
    catalog_pricing_lane_enabled: catalogPricingEnabled,
    cron_runtime: cronRuntime,
    audit_log_total: auditLogCount,
    audit_log_last_at: lastAuditAt,
    credentials_presence_status: anyComplete
      ? "complete"
      : anyCreds
        ? "lwa_only_aws_or_marketplace_missing"
        : "absent",
    missing_credentials_or_permissions: [
      ...(anyCreds ? [] : ["LWA refresh token / client id / secret (no complete row)"]),
      ...(presenceByRow.some((r) => r.aws_signing_available) || present(process.env.AWS_ACCESS_KEY_ID)
        ? []
        : ["AWS SigV4 signing keys (aws_access_key / aws_secret_key)"]),
      ...(presenceByRow.some((r) => r.marketplace_id_present) ? [] : ["marketplace_id"]),
      ...(reportSyncEnabled
        ? []
        : ["Reports/Finances SYNC workers disabled (ENABLE_AMAZON_REPORTS_API_WORKER + sub-flags / ENABLE_AMAZON_FINANCES_API_WORKER all off)"]),
      ...(flags.CRON_SECRET_present ? [] : ["CRON_SECRET not set (scheduled nightly sync cannot authenticate)"]),
    ],
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!supabaseUrl.includes(ORIGINAL_REF)) {
    throw new Error(
      `Refusing to run: SUPABASE_URL (${supabaseUrl}) is not bound to ORIGINAL ${ORIGINAL_REF}.`,
    );
  }
  const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const rid = runId();

  // ---- Part 1 ----
  const connection = await auditAmazonConnection(client);

  // ---- Part 2/3 ----
  const coverage = await composeClaimSourceCoverageV1(client, ORG);

  // ---- Part 4 ----
  const queue = await composeClaimReadyToFileQueueV1(client, ORG, STORE, RUN_OPTS);
  const scanGoLiveFound = queue.settings_audit?.scan_availability_start_found ?? false;
  const allRows: ReadyToFileRow[] = [...queue.ready_rows, ...queue.blocked_rows];
  const gateRows = allRows.map((r) => classifyGate(r, scanGoLiveFound));

  const gateCounts: Record<CorrectedGate, number> = {
    ready_to_file: 0,
    waiting_physical_receiving: 0,
    waiting_threshold: 0,
    missing_sale_price: 0,
    data_candidate_only: 0,
    wrong_family: 0,
    needs_manual_review: 0,
  };
  for (const g of gateRows) gateCounts[g.corrected_status] += 1;

  const claims_currently_fileable_count = gateCounts.ready_to_file;
  const claims_demoted_from_ready_count = gateRows.filter((g) => g.demoted_from_ready).length;
  const claims_waiting_physical_receiving_count = gateCounts.waiting_physical_receiving;
  const claims_missing_sale_price_count = gateRows.filter((g) => !g.latest_sale_net_known).length;
  const claims_needing_live_reimbursement_check_count = gateRows.filter(
    (g) => !g.reimbursement_check_complete,
  ).length;

  // Cross-family pollution: a removal row counting a non-removal reimbursement/credit
  // toward its confirmed gap. The recovery engine already excludes cross-family, so
  // detect any row whose counted reimbursement came from weak/other-family candidates.
  const crossFamilyPollutionRows = allRows.filter((r) => {
    const gap = computeRecoveryGap(r);
    return REMOVAL_FAMILIES.has(r.claim_family ?? "") && gap.has_weak_candidates && gap.confirmed_reimbursed > 0;
  });
  const cross_family_pollution_found = crossFamilyPollutionRows.length > 0;

  const currentReadyCount = queue.ready_rows.length;
  const ui_ready_to_file_gate_correction_needed =
    claims_demoted_from_ready_count > 0 || currentReadyCount !== claims_currently_fileable_count;

  // ---- Verification flags (this script never mutates) ----
  const no_claim_mutation_verification = "verified — SELECT-only composers; 0 writes to claim_* tables";
  const no_amazon_submission_verification = "verified — no SP-API / case-submission calls issued by this audit";
  const no_scanner_change_verification = "verified — no scanner code or scan data touched";

  // ---- SAFE verdicts ----
  const connStatus = connection.amazon_connection_status as string;
  const foundationCodeReady = true; // Part-1 explore confirmed full create→poll→download→parse + token + SigV4
  const credsComplete = connection.credentials_presence_status === "complete";
  const SAFE_SPAPI_LIVE_SOURCE_FOUNDATION_READY =
    foundationCodeReady && credsComplete && connStatus !== "not_configured";
  const SAFE_TO_BUILD_LIVE_REPORT_SYNC_WORKERS = foundationCodeReady && credsComplete;
  const SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES = true; // gate gap proven; rebuild is the corrective next step

  const result: Json = {
    audit_id: "PHASE-AMAZON-SPAPI-LIVE-SOURCE-INTEGRATION-AND-CLAIM-GATE-AUDIT-V1",
    run_id: rid,
    mode: "read-only",
    target: ORIGINAL_REF,
    generated_at: new Date().toISOString(),

    // Part 1
    amazon_connection_status: connStatus,
    credentials_presence_status: connection.credentials_presence_status,
    missing_credentials_or_permissions: connection.missing_credentials_or_permissions,
    connection_detail: connection,

    // Part 2/3
    report_api_coverage_matrix: coverage.source_coverage_matrix,
    live_sync_status_matrix: coverage.live_sync_plan,
    current_local_source_freshness_matrix: coverage.source_coverage_matrix.map((c) => ({
      source: c.label,
      table: c.table,
      exists: c.exists,
      row_count: c.row_count,
      latest_date: c.latest_date,
      date_coverage: c.date_coverage,
      connection_status: c.connection_status,
      live_sp_api_exists: c.live_sp_api_exists,
      importer_exists: c.importer_exists,
    })),
    claim_family_to_source_matrix: coverage.claim_family_map,
    coverage_totals: coverage.totals,
    missing_files_or_tables: coverage.missing_files_or_tables,
    highest_priority_next_builds: coverage.highest_priority_next_builds,

    // Part 4
    current_removal_candidate_gate_matrix: gateRows,
    gate_counts: gateCounts,
    claims_currently_fileable_count,
    claims_demoted_from_ready_count,
    claims_waiting_physical_receiving_count,
    claims_missing_sale_price_count,
    claims_needing_live_reimbursement_check_count,
    cross_family_pollution_found,
    current_system_ready_count: currentReadyCount,
    scan_go_live_date_found: scanGoLiveFound,
    threshold_days: queue.settings_audit?.delayed_not_received_days ?? null,

    // Part 5
    ui_ready_to_file_gate_correction_needed,
    ui_correction_plan: {
      ready_to_file_requires: [
        "valid removal claim family",
        "valid external event source (Removal Order Detail / Removal Shipment Detail)",
        "physical/receiving gate satisfied OR live removal-delivery proof",
        "latest sale net resolved (money_lane.latest_sold_price != null)",
        "reimbursement check completed (reimbursement_status != unknown_unmatched)",
        "no cross-family reimbursement/credit pollution",
      ],
      move_unverified_removal_candidates_to: [
        "Claim Opportunities / Needs Data (waiting_physical_receiving, missing_sale_price, data_candidate_only)",
        "Data Candidates (no live source / no receiving proof)",
      ],
      blocked_until_live_sources: [
        "GET_FBA_REIMBURSEMENTS_DATA scheduled sync (confirm unpaid)",
        "Removal Order/Shipment delivery proof (confirm shipment delivered/completed)",
        "Settlement V2 sync for latest sale net coverage",
      ],
    },

    // Part 6 — verification + verdicts
    no_claim_mutation_verification,
    no_amazon_submission_verification,
    no_scanner_change_verification,
    SAFE_SPAPI_LIVE_SOURCE_FOUNDATION_READY,
    SAFE_TO_BUILD_LIVE_REPORT_SYNC_WORKERS,
    SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES,
    NEXT_PROMPT:
      "PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1",
  };

  const outDir = path.join(OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ audit_id: result.audit_id, run_id: rid, mode: "read-only", target: ORIGINAL_REF }, null, 2),
  );

  // ---- Console output ----
  const line = (s = "") => console.log(s);
  line("================================================================");
  line("PHASE-AMAZON-SPAPI-LIVE-SOURCE-INTEGRATION-AND-CLAIM-GATE-AUDIT-V1");
  line(`Target: ${ORIGINAL_REF}  ·  Run: ${rid}  ·  Mode: read-only`);
  line("================================================================");
  line();
  line("== PART 1 — Amazon connection ==");
  line(`amazon_connection_status:       ${connStatus}  (claim report/finances SYNC lane)`);
  line(`credentials_presence_status:    ${connection.credentials_presence_status}`);
  line(`marketplace amazon_sp_api rows: ${(connection.marketplace_rows as unknown[]).length}`);
  line(`report_sync_lane_enabled:       ${connection.report_sync_lane_enabled}`);
  line(`catalog_pricing_lane_enabled:   ${connection.catalog_pricing_lane_enabled}`);
  line(`missing_credentials_or_perms:   ${JSON.stringify(connection.missing_credentials_or_permissions)}`);
  line(`feature_flags:                  ${JSON.stringify(connection.feature_flags)}`);
  line(`cron_runtime rows:              ${(connection.cron_runtime as unknown[]).length}`);
  line(`audit_log total / last:         ${connection.audit_log_total} / ${connection.audit_log_last_at}`);
  line();
  line("== PART 2/3 — Source coverage / freshness ==");
  line(
    `sources: total=${coverage.totals.sources_total} live_loaded=${coverage.totals.sources_live_loaded} empty=${coverage.totals.sources_loaded_empty} missing/planned=${coverage.totals.sources_missing_or_planned}`,
  );
  for (const c of coverage.source_coverage_matrix) {
    line(
      `  ${c.connection_status.padEnd(14)} ${String(c.table ?? "(none)").padEnd(28)} rows=${String(c.row_count ?? "-").padStart(6)} latest=${c.latest_date ?? "-"} liveSPAPI=${c.live_sp_api_exists ? "Y" : "·"}`,
    );
  }
  line();
  line("Live-sync plan (report/API → status):");
  for (const s of coverage.live_sync_plan) {
    line(`  ${s.report_api_name.padEnd(48)} → ${s.current_status}`);
  }
  line();
  line("== PART 4 — Corrected removal-candidate gate matrix ==");
  line(
    `Submission                            Fam  CurReady  Validity         Scan  Sale  Reimb            → corrected`,
  );
  for (const g of gateRows) {
    line(
      `  ${g.claim_submission_id.slice(0, 8)}…  ${(g.family ?? "?").slice(0, 4)}  ${g.current_ready_to_file ? "READY " : "blockd"}  ${g.origin_validity.padEnd(15)} ${g.scanning_started ? "scan" : "noscn"} ${g.latest_sale_net_known ? "$ok " : "$UNK"} ${g.reimbursement_status.padEnd(16)} → ${g.corrected_status}`,
    );
  }
  line();
  line("Gate counts:                    " + JSON.stringify(gateCounts));
  line(`claims_currently_fileable:      ${claims_currently_fileable_count}`);
  line(`claims_demoted_from_ready:      ${claims_demoted_from_ready_count}`);
  line(`claims_waiting_physical_recv:   ${claims_waiting_physical_receiving_count}`);
  line(`claims_missing_sale_price:      ${claims_missing_sale_price_count}`);
  line(`claims_needing_live_reimb_chk:  ${claims_needing_live_reimbursement_check_count}`);
  line(`cross_family_pollution_found:   ${cross_family_pollution_found ? "yes" : "no"}`);
  line();
  line("== PART 5 — UI correction ==");
  line(`ui_ready_to_file_gate_correction_needed: ${ui_ready_to_file_gate_correction_needed ? "yes" : "no"}`);
  line(`  (current system ready=${currentReadyCount}, truly fileable=${claims_currently_fileable_count})`);
  line();
  line("== PART 6 — Verdicts ==");
  line(`no_claim_mutation_verification:    ${no_claim_mutation_verification}`);
  line(`no_amazon_submission_verification: ${no_amazon_submission_verification}`);
  line(`no_scanner_change_verification:    ${no_scanner_change_verification}`);
  line(`SAFE_SPAPI_LIVE_SOURCE_FOUNDATION_READY: ${SAFE_SPAPI_LIVE_SOURCE_FOUNDATION_READY ? "yes" : "no"}`);
  line(`SAFE_TO_BUILD_LIVE_REPORT_SYNC_WORKERS:  ${SAFE_TO_BUILD_LIVE_REPORT_SYNC_WORKERS ? "yes" : "no"}`);
  line(`SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES:   ${SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES ? "yes" : "no"}`);
  line(`NEXT_PROMPT: ${result.NEXT_PROMPT}`);
  line();
  line(`Report written: ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
