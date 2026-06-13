/**
 * Source connector readiness read-model — SELECT/count only, no writes.
 * PHASE-AMAZON-ORBIT-FRA-SOURCE-CONNECTOR-READMODEL-IMPLEMENT-V1
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CLASSIFIED_REPORT_TYPES } from "@/lib/csv-import-detected-type";
import { listRegisteredClaimGenerators } from "@/lib/claims/intake/claim-generator-registry";
import {
  evaluateSourceGate,
  loadClaimIntakeSettings,
} from "@/lib/claims/intake/claim-intake-settings";
import type { ClaimSourceKind } from "@/lib/claims/intake/claim-intake-types";
import { countActiveCandidatesForOrg } from "@/lib/claims/center/claim-center-v1-read-model";
import {
  buildRemovalSupersessionReadinessSummary,
  REMOVAL_SOURCE_SUPERSESSION_RULES,
  type RemovalDetailRowLike,
  type RemovalShipmentRowLike,
  type RemovalSupersessionReadinessSummary,
} from "@/lib/claims/removal/removal-source-supersession-readmodel";

const STALE_DAYS = 45;

export type SourceTypeKind = "api" | "uploaded_file" | "generated_orbit" | "resolver" | "scanner" | "planned";

export type FreshnessStatus = "fresh" | "stale" | "missing" | "unknown";

export type SourceHealthEntry = {
  source_key: string;
  label: string;
  imported: "yes" | "no";
  row_count: number;
  last_import_at: string | null;
  last_row_at: string | null;
  org_id: string;
  store_id: string | null;
  source_type: SourceTypeKind;
  freshness_status: FreshnessStatus;
  blocker_reason: string | null;
  domain_table: string | null;
  report_type: string | null;
};

export type ClaimReadinessPayload = {
  active_candidate_count: number;
  by_source_table: Array<{
    source_table: string;
    source_kind: string | null;
    active_count: number;
  }>;
  generators: Array<{
    source_kind: string;
    title: string;
    source_tables: string[];
    generator_available: "yes" | "no";
    generator_blocked_reason: string | null;
    candidate_capable: "yes" | "no" | "partial";
    candidate_capable_count: number | null;
    active_candidate_count: number;
  }>;
};

export type TridReadinessPayload = {
  trid_capable: "yes" | "partial" | "no";
  claim_reference_edge_count: number;
  candidates_with_edges: number;
  missing_edge_reason: string | null;
  reference_fields_present: string[];
  frr_row_count: number;
  frr_coverage_note: string;
};

export type ProductStoryReadinessPayload = {
  product_identifier_map_rows: number;
  distinct_products_in_map: number | null;
  products_with_asin: number;
  product_prices_rows: number;
  dimensions_current_rows: number | null;
  linkage_resolved_on_active_candidates: number;
  linkage_pct_on_active_candidates: number;
  price_context_coverage: "partial" | "none";
  cost_context_coverage: "none";
  cost_context_note: string;
  dimension_coverage: "partial" | "none";
  evidence_upload_count: number;
  product_story_capable: "partial" | "no";
  gaps: string[];
};

export type OrbitFraReadinessPayload = {
  live_db_generator: "yes";
  generator_path: string;
  xlsx_import_status: "blocked_not_built";
  required_columns_contract: Record<string, string>;
  cogs_source_status: "not_wired";
  cogs_source_note: string;
  reference_id_type_status: "partial";
  evidence_summary_status: "generator_templates_live";
  recovery_value_rule: string;
};

export type FileApiConnectorReadinessPayload = {
  universal_importer_supported_types: string[];
  claim_relevant_report_types: string[];
  raw_report_uploads_count: number;
  last_upload_at: string | null;
  upload_lineage_note: string;
  api_automation_status: string;
  manual_import_needed: string[];
};

export type SourceConnectorReadinessPayload = {
  read_only: true;
  no_db_writes: true;
  generated_at: string;
  organization_id: string;
  store_id: string | null;
  source_health: SourceHealthEntry[];
  claim_readiness: ClaimReadinessPayload;
  trid_readiness: TridReadinessPayload;
  product_story_readiness: ProductStoryReadinessPayload;
  orbit_fra_readiness: OrbitFraReadinessPayload;
  file_api_connector_readiness: FileApiConnectorReadinessPayload;
  removal_source_supersession: RemovalSupersessionReadinessSummary | RemovalSupersessionStub;
};

/** Populated when removal detail rows are loaded for scope; otherwise rules-only stub. */
export type RemovalSupersessionStub = {
  rules_version: "v1";
  supersession_rules: typeof REMOVAL_SOURCE_SUPERSESSION_RULES;
  detail_row_count: null;
  note: "Load removal detail rows via audit script or extended query to populate counts";
};

type DomainSpec = {
  key: string;
  label: string;
  table: string | null;
  report_type: string | null;
  source_type: SourceTypeKind;
  store_scoped: boolean;
  ref_column: string | null;
  generator_kind: ClaimSourceKind | null;
};

const CLAIM_REPORT_TYPES = [
  "FBA_RETURNS",
  "REMOVAL_ORDER",
  "REMOVAL_SHIPMENT",
  "INVENTORY_LEDGER",
  "REIMBURSEMENTS",
  "SETTLEMENT",
  "SAFET_CLAIMS",
  "TRANSACTIONS",
] as const;

const DOMAIN_SPECS: DomainSpec[] = [
  {
    key: "scanner_returns",
    label: "Physical return scans",
    table: "return_items",
    report_type: null,
    source_type: "scanner",
    store_scoped: true,
    ref_column: "package_id",
    generator_kind: "scanner_physical_review",
  },
  {
    key: "fba_customer_returns",
    label: "FBA Customer Returns",
    table: "amazon_returns",
    report_type: "FBA_RETURNS",
    source_type: "uploaded_file",
    store_scoped: true,
    ref_column: "order_id",
    generator_kind: "delayed_not_received",
  },
  {
    key: "inventory_ledger",
    label: "Inventory Ledger",
    table: "amazon_inventory_ledger",
    report_type: "INVENTORY_LEDGER",
    source_type: "uploaded_file",
    store_scoped: true,
    ref_column: "reference_id",
    generator_kind: "inventory_ledger",
  },
  {
    key: "reimbursements",
    label: "Reimbursements",
    table: "amazon_reimbursements",
    report_type: "REIMBURSEMENTS",
    source_type: "uploaded_file",
    store_scoped: true,
    ref_column: "order_id",
    generator_kind: "reimbursement",
  },
  {
    key: "transactions",
    label: "Transactions",
    table: "amazon_transactions",
    report_type: "TRANSACTIONS",
    source_type: "uploaded_file",
    store_scoped: true,
    ref_column: "order_id",
    generator_kind: "transaction",
  },
  {
    key: "settlements",
    label: "Settlements",
    table: "amazon_settlements",
    report_type: "SETTLEMENT",
    source_type: "uploaded_file",
    store_scoped: true,
    ref_column: "order_id",
    generator_kind: "settlement",
  },
  {
    key: "removal_order_detail",
    label: "Removal Order Detail",
    table: "amazon_removals",
    report_type: "REMOVAL_ORDER",
    source_type: "api",
    store_scoped: true,
    ref_column: "order_id",
    generator_kind: "amazon_removal_api",
  },
  {
    key: "removal_shipment_detail",
    label: "Removal Shipment Detail",
    table: "amazon_removal_shipments",
    report_type: "REMOVAL_SHIPMENT",
    source_type: "api",
    store_scoped: true,
    ref_column: "order_id",
    generator_kind: "amazon_removal_api",
  },
  {
    key: "safet",
    label: "SAFE-T",
    table: "amazon_safet_claims",
    report_type: "SAFET_CLAIMS",
    source_type: "uploaded_file",
    store_scoped: true,
    ref_column: "order_id",
    generator_kind: "safet",
  },
  {
    key: "financial_reference_resolver",
    label: "financial_reference_resolver",
    table: "financial_reference_resolver",
    report_type: null,
    source_type: "resolver",
    store_scoped: false,
    ref_column: "order_id",
    generator_kind: null,
  },
  {
    key: "product_identifier_map",
    label: "product_identifier_map",
    table: "product_identifier_map",
    report_type: null,
    source_type: "resolver",
    store_scoped: false,
    ref_column: null,
    generator_kind: null,
  },
  {
    key: "sp_api_products",
    label: "SP-API / catalog products",
    table: "products",
    report_type: null,
    source_type: "api",
    store_scoped: true,
    ref_column: null,
    generator_kind: null,
  },
];

function freshness(lastAt: string | null, rowCount: number): FreshnessStatus {
  if (rowCount === 0) return "missing";
  if (!lastAt) return "unknown";
  const ms = Date.now() - new Date(lastAt).getTime();
  if (Number.isNaN(ms)) return "unknown";
  return ms > STALE_DAYS * 86_400_000 ? "stale" : "fresh";
}

async function countScoped(
  client: SupabaseClient,
  table: string,
  organizationId: string,
  storeId: string | null,
  storeScoped: boolean,
  notNullColumn?: string,
): Promise<number> {
  let q = client.from(table).select("*", { count: "exact", head: true }).eq("organization_id", organizationId);
  if (storeScoped && storeId) q = q.eq("store_id", storeId);
  if (notNullColumn) q = q.not(notNullColumn, "is", null);
  const { count, error } = await q;
  if (error) return 0;
  return count ?? 0;
}

async function latestTimestamp(
  client: SupabaseClient,
  table: string,
  column: string,
  organizationId: string,
  storeId: string | null,
  storeScoped: boolean,
): Promise<string | null> {
  let q = client
    .from(table)
    .select(column)
    .eq("organization_id", organizationId)
    .order(column, { ascending: false })
    .limit(1);
  if (storeScoped && storeId) q = q.eq("store_id", storeId);
  const { data, error } = await q;
  if (error || !data?.length) return null;
  const row = data[0] as unknown as Record<string, unknown>;
  const v = row[column];
  return v ? String(v) : null;
}

async function lastUploadForReport(
  client: SupabaseClient,
  organizationId: string,
  reportType: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("raw_report_uploads")
    .select("created_at")
    .eq("organization_id", organizationId)
    .eq("report_type", reportType)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data?.length) return null;
  return String((data[0] as { created_at: string }).created_at);
}

async function buildSourceHealth(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
): Promise<SourceHealthEntry[]> {
  const entries: SourceHealthEntry[] = [];

  // ORBIT workbook (planned)
  entries.push({
    source_key: "orbit_fra_workbook",
    label: "ORBIT/FRA workbook (XLSX)",
    imported: "no",
    row_count: 0,
    last_import_at: null,
    last_row_at: null,
    org_id: organizationId,
    store_id: storeId,
    source_type: "planned",
    freshness_status: "missing",
    blocker_reason: "xlsx_import_not_built; live generator reads DB tables",
    domain_table: null,
    report_type: null,
  });

  // Reports repository
  const uploadCount = await countScoped(client, "raw_report_uploads", organizationId, storeId, false);
  const lastUpload = await latestTimestamp(client, "raw_report_uploads", "created_at", organizationId, storeId, false);
  entries.push({
    source_key: "reports_repository",
    label: "Reports Repository",
    imported: uploadCount > 0 ? "yes" : "no",
    row_count: uploadCount,
    last_import_at: lastUpload,
    last_row_at: lastUpload,
    org_id: organizationId,
    store_id: null,
    source_type: "uploaded_file",
    freshness_status: freshness(lastUpload, uploadCount),
    blocker_reason: uploadCount === 0 ? "no_uploads" : null,
    domain_table: "raw_report_uploads",
    report_type: null,
  });

  for (const spec of DOMAIN_SPECS) {
    if (!spec.table) continue;
    const rowCount = await countScoped(client, spec.table, organizationId, storeId, spec.store_scoped);
    const lastRow = await latestTimestamp(
      client,
      spec.table,
      "created_at",
      organizationId,
      storeId,
      spec.store_scoped,
    );
    const lastImport = spec.report_type
      ? await lastUploadForReport(client, organizationId, spec.report_type)
      : null;
    const lastActivity = lastImport ?? lastRow;

    let blocker: string | null = null;
    if (rowCount === 0) blocker = "no_rows_in_scope";
    else if (spec.ref_column) {
      const refCount = await countScoped(
        client,
        spec.table,
        organizationId,
        storeId,
        spec.store_scoped,
        spec.ref_column,
      );
      if (refCount === 0) blocker = "missing_reference_identifiers";
    }

    entries.push({
      source_key: spec.key,
      label: spec.label,
      imported: rowCount > 0 ? "yes" : "no",
      row_count: rowCount,
      last_import_at: lastImport,
      last_row_at: lastRow,
      org_id: organizationId,
      store_id: spec.store_scoped ? storeId : null,
      source_type: spec.source_type,
      freshness_status: freshness(lastActivity, rowCount),
      blocker_reason: blocker,
      domain_table: spec.table,
      report_type: spec.report_type,
    });
  }

  return entries;
}

async function buildClaimReadiness(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  sourceHealth: SourceHealthEntry[],
): Promise<ClaimReadinessPayload> {
  const activeCandidateCount = await countActiveCandidatesForOrg(client, organizationId, {
    storeId: storeId ?? undefined,
  });

  let candidateQuery = client
    .from("claim_candidates")
    .select("source_table, source_kind")
    .eq("organization_id", organizationId)
    .is("quarantined_at", null)
    .is("rejected_at", null)
    .neq("source_kind", "legacy_seed");
  if (storeId) candidateQuery = candidateQuery.eq("store_id", storeId);
  const { data: scopedCandidates } = await candidateQuery;

  const byTableMap = new Map<string, { source_kind: string | null; count: number }>();
  for (const row of (scopedCandidates ?? []) as Array<{ source_table?: string; source_kind?: string }>) {
    const table = String(row.source_table ?? "unknown");
    const cur = byTableMap.get(table) ?? { source_kind: row.source_kind ?? null, count: 0 };
    cur.count += 1;
    if (row.source_kind) cur.source_kind = row.source_kind;
    byTableMap.set(table, cur);
  }

  const { settings } = await loadClaimIntakeSettings(client, organizationId);
  const registered = listRegisteredClaimGenerators();
  const healthByTable = new Map(sourceHealth.map((h) => [h.domain_table, h]));

  const generators = registered.map((g) => {
    const gate = evaluateSourceGate(settings, g.source_kind);
    const health = g.source_tables
      .map((t) => healthByTable.get(t))
      .find((h) => h && h.row_count > 0);
    const capableCount = health?.row_count ?? null;
    const activeForGen = (scopedCandidates ?? []).filter(
      (r) =>
        g.source_tables.includes(String((r as { source_table?: string }).source_table ?? "")) ||
        (r as { source_kind?: string }).source_kind === g.source_kind,
    ).length;

    let capable: "yes" | "no" | "partial" = "no";
    if (capableCount != null && capableCount > 0) capable = health?.blocker_reason ? "partial" : "yes";

    return {
      source_kind: g.source_kind,
      title: g.title,
      source_tables: g.source_tables,
      generator_available: (gate.skip_reason ? "no" : "yes") as "yes" | "no",
      generator_blocked_reason: gate.skip_reason,
      candidate_capable: capable,
      candidate_capable_count: capableCount,
      active_candidate_count: activeForGen,
    };
  });

  return {
    active_candidate_count: activeCandidateCount,
    by_source_table: [...byTableMap.entries()].map(([source_table, v]) => ({
      source_table,
      source_kind: v.source_kind,
      active_count: v.count,
    })),
    generators,
  };
}

async function buildTridReadiness(
  client: SupabaseClient,
  organizationId: string,
): Promise<TridReadinessPayload> {
  const edgeCount = await countScoped(client, "claim_reference_edges", organizationId, null, false);

  const { data: edgeSample } = await client
    .from("claim_reference_edges")
    .select("candidate_id")
    .eq("organization_id", organizationId)
    .limit(5000);
  const candidatesWithEdges = new Set(
    (edgeSample ?? []).map((r) => String((r as { candidate_id: string }).candidate_id)),
  ).size;

  const frrCount = await countScoped(client, "financial_reference_resolver", organizationId, null, false);

  let missingReason: string | null = null;
  if (edgeCount === 0) missingReason = "no_materialized_edges";
  else if (candidatesWithEdges === 0) missingReason = "edges_exist_but_no_candidate_join_sample";

  return {
    trid_capable: edgeCount > 0 || frrCount > 0 ? "partial" : "no",
    claim_reference_edge_count: edgeCount,
    candidates_with_edges: candidatesWithEdges,
    missing_edge_reason: missingReason,
    reference_fields_present: ["order_id", "settlement_id", "reimbursement_id", "reference_id", "tracking_number"],
    frr_row_count: frrCount,
    frr_coverage_note:
      frrCount > 0
        ? "FRR rows available for TRID join rules; materialization to claim_reference_edges may still be pending"
        : "No FRR rows — TRID financial edges blocked",
  };
}

async function buildProductStoryReadiness(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  activeCandidateCount: number,
): Promise<ProductStoryReadinessPayload> {
  const pimCount = await countScoped(client, "product_identifier_map", organizationId, null, false);
  const productsAsin = await countScoped(client, "products", organizationId, storeId, true, "asin");
  const pricesCount = await countScoped(client, "product_prices", organizationId, null, false);

  let dimensionsCount: number | null = null;
  const dimProbe = await client.from("product_packaging_dimensions_current").select("id", { count: "exact", head: true });
  if (!dimProbe.error) dimensionsCount = dimProbe.count ?? 0;

  let linked = 0;
  let q = client
    .from("claim_candidates")
    .select("resolved_product_id")
    .eq("organization_id", organizationId)
    .is("quarantined_at", null)
    .is("rejected_at", null)
    .neq("source_kind", "legacy_seed")
    .not("resolved_product_id", "is", null);
  if (storeId) q = q.eq("store_id", storeId);
  const { count: linkedCount } = await q;
  linked = linkedCount ?? 0;

  const linkagePct =
    activeCandidateCount > 0 ? Math.round((linked / activeCandidateCount) * 1000) / 10 : 0;

  const uploadCount = await countScoped(client, "raw_report_uploads", organizationId, null, false);

  const gaps: string[] = [];
  if (pimCount === 0) gaps.push("no_identifier_map_rows");
  if (pricesCount === 0) gaps.push("no_product_prices");
  if (!dimensionsCount) gaps.push("no_packaging_dimensions_current");
  if (linkagePct < 50) gaps.push("low_candidate_product_linkage");

  return {
    product_identifier_map_rows: pimCount,
    distinct_products_in_map: null,
    products_with_asin: productsAsin,
    product_prices_rows: pricesCount,
    dimensions_current_rows: dimensionsCount,
    linkage_resolved_on_active_candidates: linked,
    linkage_pct_on_active_candidates: linkagePct,
    price_context_coverage: pricesCount > 0 ? "partial" : "none",
    cost_context_coverage: "none",
    cost_context_note: "SellerSnap COGS not wired; cogs_unit sparse on candidates",
    dimension_coverage: dimensionsCount && dimensionsCount > 0 ? "partial" : "none",
    evidence_upload_count: uploadCount,
    product_story_capable: pimCount > 0 && linked > 0 ? "partial" : "no",
    gaps,
  };
}

function buildOrbitFraReadiness(): OrbitFraReadinessPayload {
  return {
    live_db_generator: "yes",
    generator_path: "lib/claims/intake/claim-orbit-fra-generator.ts",
    xlsx_import_status: "blocked_not_built",
    required_columns_contract: {
      FNSKU: "claim_candidates.fnsku",
      ASIN: "claim_candidates.asin",
      MSKU: "claim_candidates.sku",
      "Units Affected": "expected_quantity / ORBIT category units calc",
      "COGS / Unit": "cogs_unit — SellerSnap/product cost only",
      "Recovery Value": "units × cogs_unit or COGS_MISSING",
      "Event Date": "event_date",
      "Reference ID": "reference_id",
      "Reference Type": "reference_type",
      "Source Report": "metadata.source_report + upload lineage",
      "Evidence Summary": "metadata.evidence_summary",
      "Case Group": "(org, reference_type, reference_id)",
      "Case Status": "metadata display-only",
      "Amazon Reference ID": "TRID edges (order_id, reimbursement_id, removal_order_id)",
    },
    cogs_source_status: "not_wired",
    cogs_source_note: "SellerSnap not imported; ORBIT uses settings overrides + return_items fallback",
    reference_id_type_status: "partial",
    evidence_summary_status: "generator_templates_live",
    recovery_value_rule: "recovery_value = units_affected × cogs_unit when COGS exists; else report amount or COGS_MISSING",
  };
}

function buildRemovalSupersessionStub(): RemovalSupersessionStub {
  return {
    rules_version: "v1",
    supersession_rules: REMOVAL_SOURCE_SUPERSESSION_RULES,
    detail_row_count: null,
    note: "Load removal detail rows via audit script or extended query to populate counts",
  };
}

async function loadRemovalRowsForSupersession(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
): Promise<{ details: RemovalDetailRowLike[]; shipments: RemovalShipmentRowLike[] }> {
  if (!storeId) return { details: [], shipments: [] };

  const { data: details } = await client
    .from("amazon_removals")
    .select(
      "id, organization_id, store_id, order_id, sku, fnsku, disposition, order_type, shipped_quantity, in_process_quantity, tracking_number, upload_id, created_at",
    )
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .limit(8000);

  const { data: shipments } = await client
    .from("amazon_removal_shipments")
    .select("id, order_id, sku, fnsku, disposition, tracking_number, shipped_quantity")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .limit(8000);

  const uploadIds = [...new Set((details ?? []).map((r) => r.upload_id).filter(Boolean))] as string[];
  const uploadAt = new Map<string, string>();
  if (uploadIds.length > 0) {
    const { data: uploads } = await client
      .from("raw_report_uploads")
      .select("id, created_at")
      .in("id", uploadIds.slice(0, 500));
    for (const u of uploads ?? []) {
      uploadAt.set(String((u as { id: string }).id), String((u as { created_at: string }).created_at));
    }
  }

  return {
    details: (details ?? []).map((r) => {
      const row = r as RemovalDetailRowLike;
      return {
        ...row,
        id: String(row.id),
        upload_created_at: uploadAt.get(String(row.upload_id ?? "")) ?? null,
      };
    }),
    shipments: (shipments ?? []) as RemovalShipmentRowLike[],
  };
}

async function buildRemovalSupersessionReadiness(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
): Promise<RemovalSupersessionReadinessSummary | RemovalSupersessionStub> {
  const { details, shipments } = await loadRemovalRowsForSupersession(client, organizationId, storeId);
  if (details.length === 0) return buildRemovalSupersessionStub();
  return buildRemovalSupersessionReadinessSummary(details, shipments, { sample_limit: 5 });
}

function buildFileApiReadiness(
  uploadCount: number,
  lastUpload: string | null,
  sourceHealth: SourceHealthEntry[],
): FileApiConnectorReadinessPayload {
  const manual: string[] = [];
  for (const rt of CLAIM_REPORT_TYPES) {
    const health = sourceHealth.find((h) => h.report_type === rt);
    if (!health || health.row_count === 0) manual.push(rt);
  }
  if (sourceHealth.find((h) => h.source_key === "safet")?.row_count === 0) {
    if (!manual.includes("SAFET_CLAIMS")) manual.push("SAFET_CLAIMS");
  }

  return {
    universal_importer_supported_types: [...CLASSIFIED_REPORT_TYPES],
    claim_relevant_report_types: [...CLAIM_REPORT_TYPES],
    raw_report_uploads_count: uploadCount,
    last_upload_at: lastUpload,
    upload_lineage_note: "Domain rows link via upload_id / source_upload_id → raw_report_uploads",
    api_automation_status: "removal_api_sync live; reimbursements/settlement partial; returns/ledger file-only",
    manual_import_needed: manual,
  };
}

export async function buildSourceConnectorReadiness(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
): Promise<SourceConnectorReadinessPayload> {
  const source_health = await buildSourceHealth(client, organizationId, storeId);
  const claim_readiness = await buildClaimReadiness(client, organizationId, storeId, source_health);
  const trid_readiness = await buildTridReadiness(client, organizationId);
  const product_story_readiness = await buildProductStoryReadiness(
    client,
    organizationId,
    storeId,
    claim_readiness.active_candidate_count,
  );
  const orbit_fra_readiness = buildOrbitFraReadiness();
  const removal_source_supersession = await buildRemovalSupersessionReadiness(client, organizationId, storeId);
  const repo = source_health.find((h) => h.source_key === "reports_repository");
  const file_api_connector_readiness = buildFileApiReadiness(
    repo?.row_count ?? 0,
    repo?.last_import_at ?? null,
    source_health,
  );

  return {
    read_only: true,
    no_db_writes: true,
    generated_at: new Date().toISOString(),
    organization_id: organizationId,
    store_id: storeId,
    source_health,
    claim_readiness,
    trid_readiness,
    product_story_readiness,
    orbit_fra_readiness,
    file_api_connector_readiness,
    removal_source_supersession,
  };
}
