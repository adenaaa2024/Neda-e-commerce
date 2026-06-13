/**
 * PHASE-AMAZON-SPAPI-REPORTS-API-FIRST-SYNC-ROADMAP-V1
 * Read-only API-first sync architecture plan — no Amazon calls, no DB writes.
 *
 *   npx tsx scripts/phase-amazon-spapi-reports-api-first-sync-roadmap-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  AMAZON_REPORT_CROSSWALK_LIVE,
  SP_API_REPORT_TYPE_TO_SYNC_KIND,
} from "../lib/amazon/amazon-report-type-crosswalk";
import {
  isAmazonFinancesApiIngestEnabled,
  isAmazonFinancesApiWorkerEnabled,
} from "../lib/amazon/finances-api-worker-flags";
import {
  isAmazonReportsApiReimbursementsEnabled,
  isAmazonReportsApiRemovalOrderEnabled,
  isAmazonReportsApiRemovalShipmentEnabled,
  isAmazonReportsApiSettlementEnabled,
  isAmazonReportsApiWorkerEnabled,
} from "../lib/amazon/reports-api-worker-flags";
import { AMAZON_REPORT_REGISTRY, type AmazonSyncKind } from "../lib/pipeline/amazon-report-registry";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-spapi-reports-api-first-sync-roadmap-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const STALE_DAYS = 45;
const CLAIM_BACKFILL_MONTHS = 7;
const LEDGER_BACKFILL_DAYS = 545;

type ApiAvailability = "yes" | "partial" | "no";
type CodeSupport = "live" | "partial" | "planned" | "none";
type Confidence = "high" | "medium" | "low" | "unavailable";

type SourceSpec = {
  source_key: string;
  category: string;
  display_name: string;
  api_available: ApiAvailability;
  sp_api_endpoint_or_report_type: string | null;
  amazon_sync_kind: AmazonSyncKind | null;
  current_table: string | null;
  current_code_support: CodeSupport;
  env_flags: string[];
  api_route_or_worker: string | null;
  sync_frequency: string;
  backfill_range: string;
  freshness_sla: string;
  fallback_file_import: "yes" | "no" | "recommended";
  manual_ui_input: "yes" | "no" | "optional";
  source_confidence: Confidence;
  claim_use: string[];
  lifecycle_use: string[];
  product_story_use: string;
  trid_frr_use: string;
  priority: "P0" | "P1" | "P2" | "P3" | "never_api";
  implementation_phase: number;
  notes: string;
};

const SOURCE_SPECS: SourceSpec[] = [
  // ── 1. Product / catalog / listing ──
  {
    source_key: "catalog_items_api",
    category: "product_catalog",
    display_name: "Catalog Items API",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "GET /catalog/2022-04-01/items/{asin}",
    amazon_sync_kind: null,
    current_table: "products (enrichment only) / product_identifier_map adjunct",
    current_code_support: "partial",
    env_flags: ["AMAZON_SP_API_ENABLED", "PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED"],
    api_route_or_worker: "lib/pim-amazon-catalog-enrichment.ts (on-demand ASIN fetch)",
    sync_frequency: "On-demand per unresolved ASIN; nightly batch for claim cohort only",
    backfill_range: "Active catalog ASINs from listing/inventory spine",
    freshness_sla: "90d catalog attributes; list price not COGS",
    fallback_file_import: "recommended",
    manual_ui_input: "optional",
    source_confidence: "medium",
    claim_use: ["product_linkage_enrichment", "fee_dimension_attributes"],
    lifecycle_use: [],
    product_story_use: "attributes, images, productTypes, salesRanks — after SKU/ASIN linkage",
    trid_frr_use: "none",
    priority: "P2",
    implementation_phase: 6,
    notes: "Evidence-only gates (PC02). Never auto-create products. Bulk catalog sync not built.",
  },
  {
    source_key: "listings_items_api",
    category: "product_catalog",
    display_name: "Listings Items API",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "GET/PATCH /listings/2021-08-01/items/{sellerSku}",
    amazon_sync_kind: null,
    current_table: "amazon_listing_report_rows_raw (file path today)",
    current_code_support: "none",
    env_flags: [],
    api_route_or_worker: null,
    sync_frequency: "Daily delta for active SKUs (when built)",
    backfill_range: "All active seller SKUs",
    freshness_sla: "7d listing status",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "low",
    claim_use: [],
    lifecycle_use: [],
    product_story_use: "listing status, offer, fulfillment — prefer Open/All Listings report until worker exists",
    trid_frr_use: "none",
    priority: "P3",
    implementation_phase: 6,
    notes: "No Listings Items worker in repo. Reports API GET_MERCHANT_LISTINGS_* is alternate bulk path.",
  },
  {
    source_key: "open_listings_report",
    category: "product_catalog",
    display_name: "Open Listings Report",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "GET_FLAT_FILE_OPEN_LISTINGS_DATA",
    amazon_sync_kind: "ALL_LISTINGS",
    current_table: "amazon_listing_report_rows_raw",
    current_code_support: "partial",
    env_flags: ["ENABLE_AMAZON_REPORTS_API_WORKER (planned)"],
    api_route_or_worker: "UniversalImporter file-only today",
    sync_frequency: "Weekly + on catalog change",
    backfill_range: "Current snapshot",
    freshness_sla: "14d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: [],
    lifecycle_use: [],
    product_story_use: "SKU, product-id/ASIN, price — partial UPC gap",
    trid_frr_use: "none",
    priority: "P2",
    implementation_phase: 5,
    notes: "Maysam zip: Open Listings Lite tab file maps to ALL_LISTINGS importer. API worker not wired.",
  },
  {
    source_key: "manage_fba_inventory_report",
    category: "product_catalog",
    display_name: "Manage FBA Inventory report",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA",
    amazon_sync_kind: "MANAGE_FBA_INVENTORY",
    current_table: "amazon_manage_fba_inventory",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter file-only",
    sync_frequency: "Daily snapshot",
    backfill_range: "Current snapshot",
    freshness_sla: "3d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["fba_available_reserved_stranded_inventory"],
    lifecycle_use: ["available_fba", "sent_to_amazon"],
    product_story_use: "FNSKU/ASIN/SKU qty bridge",
    trid_frr_use: "graph_only",
    priority: "P2",
    implementation_phase: 3,
    notes: "Archive family in registry. AFN quantity columns for lifecycle read-model.",
  },
  // ── 2. Inventory ──
  {
    source_key: "inventory_ledger_detail",
    category: "inventory",
    display_name: "Inventory Ledger (Detail View)",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "GET_LEDGER_DETAIL_VIEW_DATA",
    amazon_sync_kind: "INVENTORY_LEDGER",
    current_table: "amazon_inventory_ledger",
    current_code_support: "partial",
    env_flags: ["ENABLE_AMAZON_REPORTS_API_WORKER (planned)", "ENABLE_AMAZON_REPORTS_API_LEDGER (planned)"],
    api_route_or_worker: "UniversalImporter file-only; no Reports API worker",
    sync_frequency: "Daily incremental; weekly 30d rolling window refresh",
    backfill_range: `${LEDGER_BACKFILL_DAYS}d (18mo ORBIT); min ${CLAIM_BACKFILL_MONTHS}mo for claims`,
    freshness_sla: "7d event-level rows",
    fallback_file_import: "recommended",
    manual_ui_input: "no",
    source_confidence: "high",
    claim_use: ["inventory_lost_damaged", "disposed_without_reimbursement"],
    lifecycle_use: ["lost", "disposed", "damaged", "unreimbursed_gap"],
    product_story_use: "reference_id edges when present",
    trid_frr_use: "ledger_pim",
    priority: "P0",
    implementation_phase: 1,
    notes: "Require Detail View not Summary View. reference_id sparse → confidence medium until backfill.",
  },
  {
    source_key: "inventory_adjustments",
    category: "inventory",
    display_name: "Inventory Adjustments",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "GET_LEDGER_DETAIL_VIEW_DATA (M*/adjustment reason filter)",
    amazon_sync_kind: "INVENTORY_LEDGER",
    current_table: "amazon_inventory_ledger",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "Same as ledger — read-model filter",
    sync_frequency: "Same as ledger",
    backfill_range: "Same as ledger",
    freshness_sla: "7d",
    fallback_file_import: "recommended",
    manual_ui_input: "no",
    source_confidence: "high",
    claim_use: ["inventory_lost_damaged"],
    lifecycle_use: ["lost", "damaged"],
    product_story_use: "adjustment events in timeline",
    trid_frr_use: "ledger_pim",
    priority: "P0",
    implementation_phase: 1,
    notes: "Not separate table — filter ledger by adjustment reason codes at ingest or read-model.",
  },
  {
    source_key: "fba_inventory_health",
    category: "inventory",
    display_name: "FBA Inventory (Health / Aged)",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "GET_FBA_INVENTORY_AGED_DATA",
    amazon_sync_kind: "FBA_INVENTORY",
    current_table: "amazon_fba_inventory",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter file-only",
    sync_frequency: "Daily snapshot",
    backfill_range: "Current + aged buckets",
    freshness_sla: "3d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["fba_available_reserved_stranded_inventory", "expired_inventory"],
    lifecycle_use: ["available_fba", "reserved_fba", "expired"],
    product_story_use: "inventory health snapshot",
    trid_frr_use: "graph_only",
    priority: "P1",
    implementation_phase: 3,
    notes: "Stranded proxy via alert/recommended_action until STRANDED table exists.",
  },
  {
    source_key: "reserved_inventory",
    category: "inventory",
    display_name: "Reserved Inventory",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "GET_RESERVED_INVENTORY_DATA",
    amazon_sync_kind: "RESERVED_INVENTORY",
    current_table: "amazon_reserved_inventory",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter file-only",
    sync_frequency: "Daily snapshot",
    backfill_range: "Current snapshot",
    freshness_sla: "3d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["fba_available_reserved_stranded_inventory"],
    lifecycle_use: ["reserved_fba"],
    product_story_use: "reserved breakdown",
    trid_frr_use: "graph_only",
    priority: "P2",
    implementation_phase: 3,
    notes: "Staging empty today — API worker planned.",
  },
  {
    source_key: "stranded_inventory",
    category: "inventory",
    display_name: "Stranded Inventory",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "GET_STRANDED_INVENTORY_UI_DATA",
    amazon_sync_kind: null,
    current_table: null,
    current_code_support: "none",
    env_flags: [],
    api_route_or_worker: null,
    sync_frequency: "Daily snapshot",
    backfill_range: "Current",
    freshness_sla: "3d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "unavailable",
    claim_use: ["fba_available_reserved_stranded_inventory"],
    lifecycle_use: ["stranded"],
    product_story_use: "stranded reason/since",
    trid_frr_use: "none",
    priority: "P2",
    implementation_phase: 4,
    notes: "No AMAZON_REPORT_REGISTRY entry. Need STRANDED_INVENTORY sync kind + table before API-first.",
  },
  {
    source_key: "daily_inventory_history",
    category: "inventory",
    display_name: "Daily Inventory History / AFN Inventory",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "GET_AFN_INVENTORY_DATA",
    amazon_sync_kind: "AMAZON_FULFILLED_INVENTORY",
    current_table: "amazon_amazon_fulfilled_inventory",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter file-only",
    sync_frequency: "Daily",
    backfill_range: "90d snapshot history",
    freshness_sla: "7d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "low",
    claim_use: [],
    lifecycle_use: ["available_fba (historical)"],
    product_story_use: "historical qty adjunct",
    trid_frr_use: "graph_only",
    priority: "P3",
    implementation_phase: 5,
    notes: "Archive family — not wired to claim generators.",
  },
  // ── 3. Returns ──
  {
    source_key: "fba_customer_returns",
    category: "returns",
    display_name: "FBA Customer Returns",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
    amazon_sync_kind: "FBA_RETURNS",
    current_table: "amazon_returns",
    current_code_support: "partial",
    env_flags: ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_FBA_RETURNS (planned)"],
    api_route_or_worker: "UniversalImporter file-only; crosswalk live, no worker",
    sync_frequency: "Daily incremental",
    backfill_range: `${CLAIM_BACKFILL_MONTHS} months`,
    freshness_sla: "14d",
    fallback_file_import: "recommended",
    manual_ui_input: "no",
    source_confidence: "high",
    claim_use: ["customer_return_not_reimbursed", "delayed_not_received"],
    lifecycle_use: ["customer_returned", "damaged"],
    product_story_use: "return reason, LPN, disposition",
    trid_frr_use: "graph_only",
    priority: "P1",
    implementation_phase: 1,
    notes: "In SP_API_REPORT_TYPE_TO_SYNC_KIND map but no pull profile/worker yet.",
  },
  {
    source_key: "customer_returns_mfn",
    category: "returns",
    display_name: "Customer Returns (MFN / non-FBA)",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: null,
    current_table: null,
    current_code_support: "none",
    env_flags: [],
    api_route_or_worker: null,
    sync_frequency: "N/A",
    backfill_range: "N/A",
    freshness_sla: "N/A",
    fallback_file_import: "yes",
    manual_ui_input: "optional",
    source_confidence: "unavailable",
    claim_use: [],
    lifecycle_use: [],
    product_story_use: "scanner physical returns primary for FBA ops",
    trid_frr_use: "none",
    priority: "never_api",
    implementation_phase: 99,
    notes: "FBA-first scope. Physical scanner return_items covers warehouse path.",
  },
  {
    source_key: "replacements",
    category: "returns",
    display_name: "Replacements",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA",
    amazon_sync_kind: "REPLACEMENTS",
    current_table: "amazon_replacements",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter file-only",
    sync_frequency: "Weekly",
    backfill_range: `${CLAIM_BACKFILL_MONTHS} months`,
    freshness_sla: "30d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["replacement_anomaly"],
    lifecycle_use: ["replacement_shipped"],
    product_story_use: "replacement order linkage",
    trid_frr_use: "graph_only",
    priority: "P3",
    implementation_phase: 5,
    notes: "Archive registry entry. Lower claim priority.",
  },
  {
    source_key: "grade_and_resell",
    category: "returns",
    display_name: "FBA Grade and Resell",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA (adjacent) / file export",
    amazon_sync_kind: "FBA_GRADE_AND_RESELL",
    current_table: "amazon_fba_grade_and_resell",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter file-only",
    sync_frequency: "Weekly",
    backfill_range: "6 months",
    freshness_sla: "30d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["graded_unit_recovery"],
    lifecycle_use: ["graded_resell"],
    product_story_use: "graded unit disposition",
    trid_frr_use: "graph_only",
    priority: "P3",
    implementation_phase: 5,
    notes: "Dedicated SP-API report type unverified in repo — file-first until confirmed.",
  },
  // ── 4. Removals ──
  {
    source_key: "removal_order_detail",
    category: "removals",
    display_name: "Removal Order Detail",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
    amazon_sync_kind: "REMOVAL_ORDER",
    current_table: "amazon_removals",
    current_code_support: "live",
    env_flags: ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER"],
    api_route_or_worker: "reports-api-removal-order-worker + removal-automation-orchestrator cron",
    sync_frequency: "2x daily (staging cron) + 7d rolling window",
    backfill_range: `${CLAIM_BACKFILL_MONTHS} months initial; rolling 7d incremental`,
    freshness_sla: "3d",
    fallback_file_import: "recommended",
    manual_ui_input: "no",
    source_confidence: "high",
    claim_use: ["removal_discrepancy", "removal_missing_units"],
    lifecycle_use: ["removed_created", "disposed"],
    product_story_use: "removal order timeline",
    trid_frr_use: "graph_only",
    priority: "P0",
    implementation_phase: 0,
    notes: "Supersession read-model excludes stale partial rows from primary totals.",
  },
  {
    source_key: "removal_shipment_detail",
    category: "removals",
    display_name: "Removal Shipment Detail",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
    amazon_sync_kind: "REMOVAL_SHIPMENT",
    current_table: "amazon_removal_shipments",
    current_code_support: "live",
    env_flags: ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT"],
    api_route_or_worker: "reports-api-removal-shipment-worker + expected_packages generic",
    sync_frequency: "2x daily with removal order",
    backfill_range: "Same as removal order",
    freshness_sla: "3d",
    fallback_file_import: "recommended",
    manual_ui_input: "no",
    source_confidence: "high",
    claim_use: ["removal_shipped_vs_detail_mismatch", "shipment_discrepancy"],
    lifecycle_use: ["removed_shipped"],
    product_story_use: "tracking + carrier evidence",
    trid_frr_use: "graph_only",
    priority: "P0",
    implementation_phase: 0,
    notes: "Primary physical evidence for scanner expected_packages linkage.",
  },
  // ── 5. Financial ──
  {
    source_key: "reimbursements",
    category: "financial",
    display_name: "Reimbursements",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "GET_FBA_REIMBURSEMENTS_DATA",
    amazon_sync_kind: "REIMBURSEMENTS",
    current_table: "amazon_reimbursements",
    current_code_support: "live",
    env_flags: ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS"],
    api_route_or_worker: "reports-api-reimbursements-worker; POST .../reports-api/run",
    sync_frequency: "Daily",
    backfill_range: `${CLAIM_BACKFILL_MONTHS} months`,
    freshness_sla: "7d",
    fallback_file_import: "recommended",
    manual_ui_input: "no",
    source_confidence: "high",
    claim_use: ["reimbursement_verification", "reimbursement_reversal"],
    lifecycle_use: ["reimbursed"],
    product_story_use: "observed recovery amounts",
    trid_frr_use: "frr",
    priority: "P0",
    implementation_phase: 0,
    notes: "Worker + route live; enable flags + Run Now. Synthetic upload → same normalized table as file.",
  },
  {
    source_key: "transactions",
    category: "financial",
    display_name: "Transactions (Simple Transactions Summary)",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: "TRANSACTIONS",
    current_table: "amazon_transactions",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter file-only",
    sync_frequency: "Weekly file pull or Reports Repository promotion",
    backfill_range: `${CLAIM_BACKFILL_MONTHS} months`,
    freshness_sla: "14d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["settlement_refund_anomaly", "transaction_negative_adjustment"],
    lifecycle_use: ["sold", "refunded_or_canceled"],
    product_story_use: "order-level money timeline",
    trid_frr_use: "frr",
    priority: "P1",
    implementation_phase: 2,
    notes: "No dedicated Reports API type in repo. Finances API adjunct possible; SKU often empty on imports.",
  },
  {
    source_key: "settlements",
    category: "financial",
    display_name: "Settlements (Flat File V2)",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
    amazon_sync_kind: "SETTLEMENT",
    current_table: "amazon_settlements",
    current_code_support: "live",
    env_flags: ["ENABLE_AMAZON_REPORTS_API_WORKER", "ENABLE_AMAZON_REPORTS_API_SETTLEMENT"],
    api_route_or_worker: "reports-api-settlement-worker; scheduled_list acquisition",
    sync_frequency: "Daily list + download new settlement reports",
    backfill_range: `${CLAIM_BACKFILL_MONTHS} months via list profile`,
    freshness_sla: "7d posted-date",
    fallback_file_import: "recommended",
    manual_ui_input: "no",
    source_confidence: "high",
    claim_use: ["settlement_refund_anomaly"],
    lifecycle_use: ["sold", "refunded_or_canceled"],
    product_story_use: "settlement line financial spine",
    trid_frr_use: "frr",
    priority: "P0",
    implementation_phase: 0,
    notes: "Worker live; enable SETTLEMENT flag + Run Now.",
  },
  {
    source_key: "financial_events_api",
    category: "financial",
    display_name: "Financial Events API",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "Finances API listFinancialEvents / listFinancialEventGroups",
    amazon_sync_kind: null,
    current_table: "amazon_finances_events (archive); not domain normalized",
    current_code_support: "partial",
    env_flags: ["ENABLE_AMAZON_FINANCES_API_WORKER", "ENABLE_AMAZON_FINANCES_API_INGEST"],
    api_route_or_worker: "finances-api-ingest-worker; POST .../finances-api/run",
    sync_frequency: "Daily incremental by posted window",
    backfill_range: "90d archive then reconcile to settlements",
    freshness_sla: "7d archive pages",
    fallback_file_import: "no",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["financial_event_reconciliation", "settlement_gap_detection"],
    lifecycle_use: [],
    product_story_use: "raw event archive — not Product Story until FRR bridge",
    trid_frr_use: "planned_frr_reconciler",
    priority: "P1",
    implementation_phase: 2,
    notes: "Archive-only today — does NOT write amazon_settlements/reimbursements. No FRR auto-promotion.",
  },
  {
    source_key: "safet_claims",
    category: "financial",
    display_name: "SAFE-T Claims",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: "SAFET_CLAIMS",
    current_table: "amazon_safet_claims",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter file-only",
    sync_frequency: "Weekly manual export until Amazon API exists",
    backfill_range: `${CLAIM_BACKFILL_MONTHS} months`,
    freshness_sla: "14d when non-empty",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "unavailable",
    claim_use: ["safet_claims", "safet_followup"],
    lifecycle_use: ["unreimbursed_gap"],
    product_story_use: "SAFE-T claim timeline",
    trid_frr_use: "graph_only",
    priority: "P0",
    implementation_phase: 0,
    notes: "Empty file = unavailable not zero. No SP-API report type in codebase.",
  },
  // ── 6. Fees ──
  {
    source_key: "fee_preview",
    category: "fees",
    display_name: "Fee Preview",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA",
    amazon_sync_kind: "FEE_PREVIEW",
    current_table: "amazon_fee_preview",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter file-only",
    sync_frequency: "Weekly snapshot",
    backfill_range: "Current catalog SKUs",
    freshness_sla: "30d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["fee_dimension_overcharge"],
    lifecycle_use: ["fee_or_dimension_issue"],
    product_story_use: "estimated fees per SKU",
    trid_frr_use: "none",
    priority: "P2",
    implementation_phase: 5,
    notes: "Claim generator deferred. Staging empty.",
  },
  {
    source_key: "monthly_storage_fees",
    category: "fees",
    display_name: "Monthly Storage Fees",
    api_available: "yes",
    sp_api_endpoint_or_report_type: "GET_FBA_STORAGE_FEE_CHARGES_DATA / GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA",
    amazon_sync_kind: "MONTHLY_STORAGE_FEES",
    current_table: "amazon_monthly_storage_fees",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter file-only; types in SP_API_REPORT_TYPE_TO_SYNC_KIND",
    sync_frequency: "Monthly after charge cycle",
    backfill_range: "12 months",
    freshness_sla: "45d post month-end",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["storage_fee_issue"],
    lifecycle_use: ["fee_or_dimension_issue"],
    product_story_use: "storage charge history",
    trid_frr_use: "none",
    priority: "P2",
    implementation_phase: 5,
    notes: "Crosswalk maps SP-API types; worker not scheduled.",
  },
  {
    source_key: "low_inventory_level_fee",
    category: "fees",
    display_name: "Low Inventory Level Fee",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "GET_FBA_INVENTORY_PLANNING_DATA (adjacent) / Seller Central export",
    amazon_sync_kind: null,
    current_table: null,
    current_code_support: "none",
    env_flags: [],
    api_route_or_worker: null,
    sync_frequency: "Monthly",
    backfill_range: "6 months",
    freshness_sla: "45d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "low",
    claim_use: ["low_inventory_fee_issue"],
    lifecycle_use: ["fee_or_dimension_issue"],
    product_story_use: "fee rate evidence",
    trid_frr_use: "none",
    priority: "P3",
    implementation_phase: 5,
    notes: "Maysam zip captured schema; no registry table. Design table before API worker.",
  },
  {
    source_key: "returns_processing_fee",
    category: "fees",
    display_name: "Returns Processing Fee",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: null,
    current_table: null,
    current_code_support: "none",
    env_flags: [],
    api_route_or_worker: null,
    sync_frequency: "Monthly file",
    backfill_range: "3 months",
    freshness_sla: "45d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "low",
    claim_use: ["returns_processing_fee_issue"],
    lifecycle_use: ["fee_or_dimension_issue"],
    product_story_use: "dimensional fee schedule",
    trid_frr_use: "none",
    priority: "P3",
    implementation_phase: 5,
    notes: "Dimensional/weight columns — file-first; no SP-API type in repo.",
  },
  {
    source_key: "inbound_placement_fees",
    category: "fees",
    display_name: "Inbound Placement Service Fees",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: null,
    current_table: null,
    current_code_support: "none",
    env_flags: [],
    api_route_or_worker: null,
    sync_frequency: "Monthly file",
    backfill_range: "6 months",
    freshness_sla: "45d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "low",
    claim_use: ["inbound_placement_fee_issue"],
    lifecycle_use: ["sent_to_amazon"],
    product_story_use: "placement fee evidence",
    trid_frr_use: "none",
    priority: "P3",
    implementation_phase: 5,
    notes: "Maysam zip schema captured. No normalized table.",
  },
  // ── 7. Inbound ──
  {
    source_key: "inbound_performance",
    category: "inbound",
    display_name: "Inbound Performance",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "GET_FBA_INBOUND_PERFORMANCE_DATA",
    amazon_sync_kind: "INBOUND_PERFORMANCE",
    current_table: "amazon_inbound_performance",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter file-only",
    sync_frequency: "Weekly",
    backfill_range: `${CLAIM_BACKFILL_MONTHS} months`,
    freshness_sla: "14d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["inbound_shipment_shortage", "inbound_shipment_discrepancy"],
    lifecycle_use: ["sent_to_amazon", "received_by_amazon"],
    product_story_use: "shipment problem timeline",
    trid_frr_use: "graph_only",
    priority: "P1",
    implementation_phase: 3,
    notes: "Includes received_quantity column — Received Inventory is not separate table.",
  },
  {
    source_key: "inbound_shipment_detail",
    category: "inbound",
    display_name: "Inbound Shipment Detail",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "Fulfillment Inbound API getShipments / GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA",
    amazon_sync_kind: null,
    current_table: null,
    current_code_support: "none",
    env_flags: [],
    api_route_or_worker: null,
    sync_frequency: "Daily for open shipments",
    backfill_range: `${CLAIM_BACKFILL_MONTHS} months`,
    freshness_sla: "7d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "low",
    claim_use: ["inbound_shipment_discrepancy"],
    lifecycle_use: ["sent_to_amazon", "received_by_amazon"],
    product_story_use: "shipment qty shipped/received",
    trid_frr_use: "none",
    priority: "P2",
    implementation_phase: 4,
    notes: "Optional future amazon_inbound_shipments table referenced in materialization scripts only.",
  },
  {
    source_key: "received_inventory",
    category: "inbound",
    display_name: "Received Inventory",
    api_available: "partial",
    sp_api_endpoint_or_report_type: "Column on GET_FBA_INBOUND_PERFORMANCE_DATA / inbound shipment APIs",
    amazon_sync_kind: "INBOUND_PERFORMANCE",
    current_table: "amazon_inbound_performance",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "Same as inbound performance",
    sync_frequency: "Weekly",
    backfill_range: "Same as inbound performance",
    freshness_sla: "14d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["inbound_shipment_shortage"],
    lifecycle_use: ["received_by_amazon"],
    product_story_use: "received qty per shipment line",
    trid_frr_use: "graph_only",
    priority: "P1",
    implementation_phase: 3,
    notes: "Not standalone — received_quantity on inbound_performance rows.",
  },
  {
    source_key: "shipment_reconciliation",
    category: "inbound",
    display_name: "Shipment Reconciliation",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: null,
    current_table: null,
    current_code_support: "none",
    env_flags: [],
    api_route_or_worker: null,
    sync_frequency: "Weekly file",
    backfill_range: `${CLAIM_BACKFILL_MONTHS} months`,
    freshness_sla: "14d",
    fallback_file_import: "yes",
    manual_ui_input: "no",
    source_confidence: "low",
    claim_use: ["inbound_shipment_discrepancy"],
    lifecycle_use: ["sent_to_amazon", "received_by_amazon"],
    product_story_use: "expected vs received",
    trid_frr_use: "none",
    priority: "P2",
    implementation_phase: 4,
    notes: "Partial via inbound_performance + expected_packages until dedicated table.",
  },
  // ── 8. Third-party / internal ──
  {
    source_key: "sellersnap_cogs",
    category: "third_party",
    display_name: "SellerSnap COGS export",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: null,
    current_table: "product_prices (NOT authoritative for COGS)",
    current_code_support: "none",
    env_flags: [],
    api_route_or_worker: null,
    sync_frequency: "Weekly external export",
    backfill_range: "Current SKU costs",
    freshness_sla: "30d",
    fallback_file_import: "yes",
    manual_ui_input: "optional",
    source_confidence: "unavailable",
    claim_use: ["all recovery_value families", "ORBIT/FRA"],
    lifecycle_use: ["all money lanes"],
    product_story_use: "unit cost spine — required before trusted claim money",
    trid_frr_use: "none",
    priority: "P0",
    implementation_phase: 99,
    notes: "Never use product_prices or sale price as COGS. Dedicated external_export importer needed.",
  },
  {
    source_key: "purchase_cost",
    category: "third_party",
    display_name: "Purchase cost (internal ERP)",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: null,
    current_table: null,
    current_code_support: "none",
    env_flags: [],
    api_route_or_worker: null,
    sync_frequency: "On PO receipt / periodic sync",
    backfill_range: "Active SKU costs",
    freshness_sla: "30d",
    fallback_file_import: "yes",
    manual_ui_input: "yes",
    source_confidence: "low",
    claim_use: ["recovery_value"],
    lifecycle_use: [],
    product_story_use: "landed cost adjunct",
    trid_frr_use: "none",
    priority: "P1",
    implementation_phase: 99,
    notes: "Internal ERP — manual UI or future vendor integration.",
  },
  {
    source_key: "landed_cost",
    category: "third_party",
    display_name: "Landed cost",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: null,
    current_table: null,
    current_code_support: "none",
    env_flags: [],
    api_route_or_worker: null,
    sync_frequency: "Monthly",
    backfill_range: "Active SKUs",
    freshness_sla: "45d",
    fallback_file_import: "yes",
    manual_ui_input: "yes",
    source_confidence: "low",
    claim_use: ["recovery_value"],
    lifecycle_use: [],
    product_story_use: "cost breakdown",
    trid_frr_use: "none",
    priority: "P2",
    implementation_phase: 99,
    notes: "Computed or imported — not Amazon API.",
  },
  {
    source_key: "product_identity_upc",
    category: "third_party",
    display_name: "UPC / Product Identity CSV",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: "PRODUCT_IDENTITY",
    current_table: "product_identifier_map",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "UniversalImporter PRODUCT_IDENTITY",
    sync_frequency: "On catalog change",
    backfill_range: "Full active catalog",
    freshness_sla: "30d",
    fallback_file_import: "yes",
    manual_ui_input: "yes",
    source_confidence: "high",
    claim_use: ["product_linkage"],
    lifecycle_use: [],
    product_story_use: "UPC, Vendor, Mfg#, FNSKU, ASIN spine — prerequisite for trusted linkage",
    trid_frr_use: "none",
    priority: "P0",
    implementation_phase: 99,
    notes: "Must resolve linkage before Product Story / claim money trusted.",
  },
  {
    source_key: "internal_dimensions_weight",
    category: "third_party",
    display_name: "Internal dimensions / weight",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: null,
    current_table: "packaging dimensions contract (PC04)",
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "Manual / scanner measurement",
    sync_frequency: "On measure event",
    backfill_range: "Claim cohort SKUs",
    freshness_sla: "90d",
    fallback_file_import: "optional",
    manual_ui_input: "yes",
    source_confidence: "medium",
    claim_use: ["fee_dimension_overcharge"],
    lifecycle_use: ["fee_or_dimension_issue"],
    product_story_use: "actual dims vs Amazon charged dims",
    trid_frr_use: "none",
    priority: "P2",
    implementation_phase: 99,
    notes: "Amazon fee reports provide charged dims; internal truth is operator/scanner input.",
  },
  {
    source_key: "orbit_fra_workbook",
    category: "third_party",
    display_name: "ORBIT/FRA workbook",
    api_available: "no",
    sp_api_endpoint_or_report_type: null,
    amazon_sync_kind: null,
    current_table: null,
    current_code_support: "partial",
    env_flags: [],
    api_route_or_worker: "claim-orbit-fra-generator.ts (derived from DB)",
    sync_frequency: "N/A — derived output",
    backfill_range: "N/A",
    freshness_sla: "N/A",
    fallback_file_import: "no",
    manual_ui_input: "no",
    source_confidence: "medium",
    claim_use: ["ORBIT/FRA fight list"],
    lifecycle_use: ["computed"],
    product_story_use: "audit export — not primary ingestion",
    trid_frr_use: "none",
    priority: "P3",
    implementation_phase: 99,
    notes: "XLSX import blocked. Generator reads normalized Amazon tables + COGS when available.",
  },
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function censusTable(
  c: pg.Client,
  table: string,
  storeScoped: boolean,
): Promise<{ row_count: number; last_row_at: string | null }> {
  const exists = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  if (!exists.rows[0]?.ok) return { row_count: 0, last_row_at: null };
  const scope = storeScoped
    ? `organization_id = '${ORG}'::uuid AND store_id = '${STORE}'::uuid`
    : `organization_id = '${ORG}'::uuid`;
  const r = await c.query(
    `SELECT COUNT(*)::bigint AS c, MAX(created_at)::text AS last FROM public.${table} WHERE ${scope}`,
  );
  return { row_count: Number(r.rows[0]?.c ?? 0), last_row_at: r.rows[0]?.last ?? null };
}

function freshnessSlaMet(lastAt: string | null, rowCount: number, slaDays: number): boolean {
  if (rowCount === 0) return false;
  if (!lastAt) return false;
  return Date.now() - new Date(lastAt).getTime() <= slaDays * 86_400_000;
}

function renderMarkdown(payload: Record<string, unknown>): string {
  const matrix = payload.api_first_source_matrix as Array<SourceSpec & { staging_row_count?: number }>;
  let md = `# PHASE-AMAZON-SPAPI-REPORTS-API-FIRST-SYNC-ROADMAP-V1\n\n`;
  md += `Run: \`${payload.run_id}\`\n\n`;
  md += `## SAFE_TO_IMPLEMENT_FIRST_API_SYNC_PHASE: **${payload.SAFE_TO_IMPLEMENT_FIRST_API_SYNC_PHASE}**\n\n`;
  md += `## Architecture law\n\n`;
  md += `- Amazon API → synthetic upload → normalized domain table → claim generators\n`;
  md += `- Empty source = unavailable, not zero\n`;
  md += `- COGS from cost source only — never sale price\n`;
  md += `- Product linkage before trusted Product Story / claim money\n\n`;
  md += `## API-first source matrix (${matrix.length} sources)\n\n`;
  md += `| Source | API | Code | Table | Freq | Fallback file | Phase |\n`;
  md += `|--------|-----|------|-------|------|---------------|-------|\n`;
  for (const r of matrix) {
    md += `| ${r.display_name} | ${r.api_available} | ${r.current_code_support} | ${r.current_table ?? "—"} | ${r.sync_frequency.split(";")[0]} | ${r.fallback_file_import} | ${r.implementation_phase} |\n`;
  }
  md += `\n## Implementation phases\n\n`;
  for (const ph of payload.implementation_phases as Array<{ phase: number; name: string; sources: string[] }>) {
    md += `### Phase ${ph.phase}: ${ph.name}\n`;
    for (const s of ph.sources) md += `- ${s}\n`;
    md += `\n`;
  }
  md += `\n## NEXT_EXACT_PROMPT\n\n\`${payload.NEXT_EXACT_PROMPT}\`\n`;
  return md;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url?.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL must target staging");

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '120s'");
  await c.query("SET default_transaction_read_only = ON");

  const api_first_source_matrix = [];
  for (const spec of SOURCE_SPECS) {
    let staging_row_count: number | null = null;
    let staging_last_at: string | null = null;
    if (spec.current_table && !spec.current_table.includes("(")) {
      const table = spec.current_table.split(" ")[0]!;
      const storeScoped =
        table !== "amazon_inventory_ledger" &&
        table !== "product_identifier_map" &&
        table !== "amazon_finances_events";
      const stats = await censusTable(c, table, storeScoped);
      staging_row_count = stats.row_count;
      staging_last_at = stats.last_row_at;
    }
    api_first_source_matrix.push({
      ...spec,
      staging_row_count,
      staging_last_at,
      staging_fresh:
        staging_row_count != null && staging_last_at
          ? Date.now() - new Date(staging_last_at).getTime() <= STALE_DAYS * 86_400_000
            ? "fresh"
            : "stale"
          : staging_row_count === 0
            ? "missing"
            : "unknown",
    });
  }
  await c.end();

  const reports_api_report_type_map = Object.entries(SP_API_REPORT_TYPE_TO_SYNC_KIND).map(
    ([reportType, kind]) => ({
      sp_api_report_type: reportType,
      amazon_sync_kind: kind,
      sync_target_table: AMAZON_REPORT_REGISTRY[kind]?.sync_target_table ?? null,
      worker_profile:
        kind === "REIMBURSEMENTS"
          ? "REIMBURSEMENTS_PULL_PROFILE"
          : kind === "SETTLEMENT"
            ? "SETTLEMENT_PULL_PROFILE"
            : kind === "REMOVAL_ORDER"
              ? "REMOVAL_ORDER_PULL_PROFILE"
              : kind === "REMOVAL_SHIPMENT"
                ? "REMOVAL_SHIPMENT_PULL_PROFILE"
                : null,
      in_static_crosswalk: AMAZON_REPORT_CROSSWALK_LIVE.some((r) => r.amazon_report_type === reportType),
    }),
  );

  const existing_sync_support = {
    reports_api_master: isAmazonReportsApiWorkerEnabled(),
    reports_api_reimbursements: isAmazonReportsApiReimbursementsEnabled(),
    reports_api_settlement: isAmazonReportsApiSettlementEnabled(),
    reports_api_removal_order: isAmazonReportsApiRemovalOrderEnabled(),
    reports_api_removal_shipment: isAmazonReportsApiRemovalShipmentEnabled(),
    finances_api_worker: isAmazonFinancesApiWorkerEnabled(),
    finances_api_ingest: isAmazonFinancesApiIngestEnabled(),
    live_workers: [
      "reports-api-reimbursements-worker",
      "reports-api-settlement-worker",
      "reports-api-removal-order-worker",
      "reports-api-removal-shipment-worker",
      "finances-api-ingest-worker (archive only)",
    ],
    live_routes: [
      "POST /api/settings/imports/reports-api/run",
      "POST /api/settings/imports/reports-api/settlement/run",
      "POST /api/settings/imports/reports-api/removal-order/run",
      "POST /api/settings/imports/reports-api/removal-shipment/run",
      "POST /api/settings/imports/finances-api/run",
    ],
    removal_automation_cron: ".github/workflows/removal-automation-staging.yml (2x daily)",
  };

  const missing_sync_jobs = SOURCE_SPECS.filter(
    (s) =>
      s.api_available !== "no" &&
      s.current_code_support !== "live" &&
      s.implementation_phase < 99 &&
      s.category !== "third_party",
  ).map((s) => ({
    source_key: s.source_key,
    display_name: s.display_name,
    sp_api: s.sp_api_endpoint_or_report_type,
    target_table: s.current_table,
    priority: s.priority,
    phase: s.implementation_phase,
    blocker: s.notes,
  }));

  const fallback_file_imports = SOURCE_SPECS.filter((s) => s.fallback_file_import !== "no").map(
    (s) => ({
      source_key: s.source_key,
      display_name: s.display_name,
      reason:
        s.api_available === "no"
          ? "No reliable Amazon API"
          : s.current_code_support !== "live"
            ? "API worker not built yet"
            : "Disaster recovery / schema validation",
      amazon_sync_kind: s.amazon_sync_kind,
      table: s.current_table,
    }),
  );

  const manual_user_input_sources = SOURCE_SPECS.filter((s) => s.manual_ui_input !== "no").map(
    (s) => ({
      source_key: s.source_key,
      display_name: s.display_name,
      manual_ui_input: s.manual_ui_input,
      notes: s.notes,
    }),
  );

  const sync_frequency_plan = SOURCE_SPECS.filter((s) => s.implementation_phase < 99).map((s) => ({
    source_key: s.source_key,
    sync_frequency: s.sync_frequency,
    api_first: s.api_available === "yes" && s.current_code_support === "live",
  }));

  const backfill_plan = SOURCE_SPECS.filter((s) => s.implementation_phase < 99).map((s) => ({
    source_key: s.source_key,
    backfill_range: s.backfill_range,
    priority: s.priority,
  }));

  const freshness_sla = SOURCE_SPECS.filter((s) => s.implementation_phase < 99).map((s) => ({
    source_key: s.source_key,
    freshness_sla: s.freshness_sla,
    staging_row_count: api_first_source_matrix.find((m) => m.source_key === s.source_key)
      ?.staging_row_count,
    staging_fresh: api_first_source_matrix.find((m) => m.source_key === s.source_key)?.staging_fresh,
  }));

  const priority_order_for_claim_delivery = [
    ...SOURCE_SPECS.filter((s) => s.priority === "P0").map((s) => s.display_name),
    ...SOURCE_SPECS.filter((s) => s.priority === "P1").map((s) => s.display_name),
    ...SOURCE_SPECS.filter((s) => s.priority === "P2").map((s) => s.display_name),
    ...SOURCE_SPECS.filter((s) => s.priority === "P3").map((s) => s.display_name),
  ];

  const implementation_phases = [
    {
      phase: 0,
      name: "Enable existing Reports API workers (no new code)",
      sources: SOURCE_SPECS.filter((s) => s.implementation_phase === 0).map((s) => s.display_name),
      actions: [
        "ENABLE_AMAZON_REPORTS_API_WORKER=true",
        "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS=true",
        "ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true",
        "Verify removal cron apply gate + 2x daily schedule",
        "Run Now: reimbursements + settlements 7mo backfill",
        "SAFE-T + SellerSnap remain file/manual until non-API paths filled",
      ],
    },
    {
      phase: 1,
      name: "Claim-core Reports API workers (ledger + FBA returns)",
      sources: SOURCE_SPECS.filter((s) => s.implementation_phase === 1).map((s) => s.display_name),
      actions: [
        "Add GET_LEDGER_DETAIL_VIEW_DATA pull profile + worker + ENABLE_AMAZON_REPORTS_API_LEDGER",
        "Add GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA worker",
        "545d ledger backfill; 7mo returns backfill",
        "Keep file fallback for Summary-vs-Detail ledger mismatch",
      ],
    },
    {
      phase: 2,
      name: "Financial depth (Finances API bridge + transactions policy)",
      sources: SOURCE_SPECS.filter((s) => s.implementation_phase === 2).map((s) => s.display_name),
      actions: [
        "Enable Finances API ingest on schedule",
        "Build FRR reconciler promotion: amazon_finances_events → financial_reference_resolver",
        "Transactions: keep file-first until Finances/Repository promotion policy locked",
      ],
    },
    {
      phase: 3,
      name: "Inventory snapshots + inbound performance",
      sources: SOURCE_SPECS.filter((s) => s.implementation_phase === 3).map((s) => s.display_name),
      actions: [
        "Reports API workers: FBA Inventory Aged, Reserved, Manage FBA, Inbound Performance",
        "Daily snapshot cron",
      ],
    },
    {
      phase: 4,
      name: "Stranded + inbound shipment detail + reconciliation",
      sources: SOURCE_SPECS.filter((s) => s.implementation_phase === 4).map((s) => s.display_name),
      actions: [
        "Add STRANDED_INVENTORY sync kind + amazon_stranded_inventory table (schema approval)",
        "Inbound shipment detail table or Fulfillment Inbound API projection",
        "Shipment reconciliation derived view or dedicated import",
      ],
    },
    {
      phase: 5,
      name: "Fee reports + listing bulk + archive families",
      sources: SOURCE_SPECS.filter((s) => s.implementation_phase === 5).map((s) => s.display_name),
      actions: [
        "Fee Preview, Monthly Storage, Low-inventory fee tables/workers as approved",
        "Open Listings Reports API worker",
        "Returns Processing Fee + Inbound Placement — file-first until SP-API types confirmed",
      ],
    },
    {
      phase: 6,
      name: "Catalog API enrichment (governed, not bulk replace)",
      sources: SOURCE_SPECS.filter((s) => s.implementation_phase === 6).map((s) => s.display_name),
      actions: [
        "Governed Catalog Items batch for unresolved ASINs (PC02 gates)",
        "Listings Items API evaluation vs Reports listing bulk",
      ],
    },
    {
      phase: 99,
      name: "Third-party / manual — never Amazon API",
      sources: SOURCE_SPECS.filter((s) => s.implementation_phase === 99).map((s) => s.display_name),
      actions: [
        "SellerSnap COGS external_export importer",
        "Product Identity CSV upload",
        "Internal dimensions / purchase cost manual UI",
        "ORBIT/FRA stays derived",
      ],
    },
  ];

  const phase0LiveCount = SOURCE_SPECS.filter(
    (s) => s.implementation_phase === 0 && s.current_code_support === "live",
  ).length;

  const SAFE_TO_IMPLEMENT_FIRST_API_SYNC_PHASE =
    phase0LiveCount >= 3 && reports_api_report_type_map.filter((r) => r.worker_profile).length >= 4
      ? "yes"
      : "partial";

  const NEXT_EXACT_PROMPT =
    "PHASE-AMAZON-REPORTS-API-PHASE0-ENABLE-AND-BACKFILL-V1 — staging: enable REIMBURSEMENTS+SETTLEMENT flags, Run Now 7mo window, verify removal cron apply; then PHASE-AMAZON-REPORTS-API-LEDGER-WORKER-PLAN-V1";

  const summary = {
    prompt: "PHASE-AMAZON-SPAPI-REPORTS-API-FIRST-SYNC-ROADMAP-V1",
    run_id: rid,
    mode: "read_only",
    staging_ref: STAGING_REF,
    architecture_laws: [
      "Amazon API → synthetic raw_report_upload → normalized domain table → claim generators",
      "Claim generators never consume raw files directly",
      "Empty source = unavailable not zero",
      "Conflicting rows → source reconciliation / supersession read-models",
      "COGS from cost source only — never sale price or product_prices",
      "Product linkage (product_identifier_map) before trusted Product Story / claim money",
    ],
    api_first_source_matrix,
    reports_api_report_type_map,
    existing_sync_support,
    missing_sync_jobs,
    fallback_file_imports,
    manual_user_input_sources,
    sync_frequency_plan,
    backfill_plan,
    freshness_sla,
    priority_order_for_claim_delivery,
    implementation_phases,
    claim_delivery_critical_path: [
      "P0: reimbursements + settlements API enable",
      "P0: ledger detail API worker",
      "P0: product identity / SellerSnap COGS (manual)",
      "P1: FBA returns API worker",
      "P1: Finances API → FRR bridge",
      "P1: inbound performance API worker",
    ],
    zip_audit_cross_ref: "phase-amazon-sample-zip-source-coverage-audit-v1/20260613T003412Z",
    SAFE_TO_IMPLEMENT_FIRST_API_SYNC_PHASE,
    NEXT_EXACT_PROMPT,
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "api-first-sync-roadmap.md"), renderMarkdown(summary), "utf8");
  fs.writeFileSync(path.join(outDir, "NEXT_EXACT_PROMPT.txt"), NEXT_EXACT_PROMPT);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
