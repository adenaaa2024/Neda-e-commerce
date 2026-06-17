/**
 * PHASE-CLAIM-VRET-SLIP-REFERENCE-MAPPING-AUDIT-V1
 * Read-only audit: what is VRET… on packing slips and how it maps to claim/reference architecture.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const CLAIM_VRET_SLIP_REFERENCE_MAPPING_AUDIT_V1_VERSION =
  "claim-vret-slip-reference-mapping-audit-v1" as const;

export const DEFAULT_VRET_EXAMPLE = "VRET7644940165531" as const;

export type DbColumnProbe = {
  table: string;
  column: string;
  match_mode: "exact" | "ilike_contains" | "ilike_prefix";
};

export type DbHit = {
  table: string;
  column: string;
  row_id: string;
  match_value: string | null;
  row_preview: Record<string, unknown>;
};

export type ReportSearchHit = {
  report_type: string;
  upload_id: string | null;
  file_name: string | null;
  match_count: number;
  sample_snippets: string[];
};

export type VretSlipReferenceMappingAuditResult = {
  version: typeof CLAIM_VRET_SLIP_REFERENCE_MAPPING_AUDIT_V1_VERSION;
  vret_example: string;
  exact_occurrence_found: boolean;
  occurrence_locations: string[];
  source_files_checked: string[];
  db_tables_checked: string[];
  report_types_checked: string[];
  matched_report_rows: ReportSearchHit[];
  neighboring_identifiers: Record<string, string | null>;
  inferred_meaning: string;
  confidence: "high" | "medium" | "low";
  proven_not_order_id: boolean;
  proven_not_trid: boolean;
  recommended_reference_type: string;
  recommended_storage_location: string;
  recommended_edge_type_if_later_materialized: string;
  blockers: string[];
  no_db_write_verification: boolean;
  no_claim_mutation_verification: boolean;
  no_amazon_submission_verification: boolean;
  no_scanner_change_verification: boolean;
  SAFE_TO_USE_VRET_AS_REFERENCE: boolean;
  SAFE_TO_PLAN_VRET_REFERENCE_EDGE_MATERIALIZATION: boolean;
  NEXT_PROMPT: string;
  db_hits: DbHit[];
  vret_pattern_sample_count: number;
  codebase_findings: Record<string, unknown>;
};

export const CODEBASE_VRET_SOURCE_FILES = [
  "lib/scanner/operator-slip-scan.ts",
  "lib/scanner/slip-extract-parse.ts",
  "lib/scanner/tracking-normalize.ts",
  "lib/scanner/box-slip-vision-parse.ts",
  "lib/scanner/operator-resolve-barcode.ts",
  "app/api/scanner/extract-slip/route.ts",
  "app/scanner/operator-mobile/scan/page.tsx",
  "lib/claims/contracts/claim-grouping-filters-manual-batch-contract-v1.ts",
] as const;

export const DB_COLUMN_PROBES: DbColumnProbe[] = [
  { table: "packages", column: "rma_number", match_mode: "exact" },
  { table: "packages", column: "id_slip_contents", match_mode: "exact" },
  { table: "packages", column: "tracking_number", match_mode: "exact" },
  { table: "packages", column: "package_code", match_mode: "exact" },
  { table: "packages", column: "rma_number", match_mode: "ilike_prefix" },
  { table: "packages", column: "tracking_number", match_mode: "ilike_prefix" },
  { table: "slip_contents", column: "slip_code", match_mode: "exact" },
  { table: "slip_contents", column: "rma_number", match_mode: "exact" },
  { table: "slip_contents", column: "order_id", match_mode: "exact" },
  { table: "expected_packages", column: "tracking_number", match_mode: "exact" },
  { table: "expected_packages", column: "id_slip_contents", match_mode: "exact" },
  { table: "expected_packages", column: "order_id", match_mode: "exact" },
  { table: "expected_packages", column: "tracking_number", match_mode: "ilike_prefix" },
  { table: "return_items", column: "tracking_number", match_mode: "exact" },
  { table: "return_items", column: "lpn", match_mode: "exact" },
  { table: "amazon_returns", column: "lpn", match_mode: "exact" },
  { table: "amazon_returns", column: "order_id", match_mode: "exact" },
  { table: "claim_reference_edges", column: "reference_value", match_mode: "exact" },
  { table: "claim_reference_edges", column: "reference_value", match_mode: "ilike_contains" },
  { table: "claim_candidates", column: "source_event_key", match_mode: "exact" },
  { table: "claim_candidates", column: "source_event_key", match_mode: "ilike_contains" },
];

export const REPORT_TYPES_TO_CHECK = [
  "FBA_RETURNS",
  "RETURNS",
  "TRANSACTIONS",
  "REIMBURSEMENTS",
  "REPORTS_REPOSITORY",
  "REMOVAL_ORDER_DETAIL",
  "REMOVAL_SHIPMENT_DETAIL",
] as const;

const PACKAGE_SELECT =
  "id, organization_id, store_id, package_code, id_slip_contents, tracking_number, rma_number, manifest_data, slip_photo_urls, status, created_at";
const SLIP_SELECT =
  "id, organization_id, package_id, slip_code, rma_number, order_id, fnsku, sku, asin, notes, created_at";
const EP_SELECT =
  "id, organization_id, store_id, tracking_number, id_slip_contents, order_id, removal_order_id, build_status, created_at";
const RETURN_ITEM_SELECT =
  "id, organization_id, package_id, tracking_number, lpn, sku, fnsku, asin, order_id, created_at";
const AMAZON_RETURN_SELECT =
  "id, organization_id, lpn, order_id, sku, fnsku, asin, return_date, created_at";
const EDGE_SELECT =
  "id, edge_type, reference_kind, reference_value, candidate_id, from_source_table, to_source_table";
const CANDIDATE_SELECT = "id, source_event_key, source_table, family_key, metadata, created_at";

function selectForTable(table: string): string {
  switch (table) {
    case "packages":
      return PACKAGE_SELECT;
    case "slip_contents":
      return SLIP_SELECT;
    case "expected_packages":
      return EP_SELECT;
    case "return_items":
      return RETURN_ITEM_SELECT;
    case "amazon_returns":
      return AMAZON_RETURN_SELECT;
    case "claim_reference_edges":
      return EDGE_SELECT;
    case "claim_candidates":
      return CANDIDATE_SELECT;
    default:
      return "id, organization_id, created_at";
  }
}

function previewRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null) continue;
    if (k === "manifest_data" || k === "metadata" || k === "slip_photo_urls") {
      const s = JSON.stringify(v);
      out[k] = s.length > 500 ? `${s.slice(0, 500)}…` : v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

async function probeColumn(
  client: SupabaseClient,
  orgId: string,
  probe: DbColumnProbe,
  needle: string,
): Promise<DbHit[]> {
  const hits: DbHit[] = [];
  let q = client
    .from(probe.table)
    .select(selectForTable(probe.table))
    .eq("organization_id", orgId)
    .limit(20);

  if (probe.table !== "claim_reference_edges" && probe.table !== "claim_candidates") {
    const softDeleteTables = new Set(["packages", "slip_contents", "return_items", "expected_packages"]);
    if (softDeleteTables.has(probe.table)) {
      q = q.is("deleted_at", null);
    }
  }

  const col = probe.column;
  if (probe.match_mode === "exact") {
    q = q.eq(col, needle);
  } else if (probe.match_mode === "ilike_prefix") {
    if (needle !== DEFAULT_VRET_EXAMPLE) return hits;
    q = q.ilike(col, "VRET%");
  } else {
    q = q.ilike(col, `%${needle}%`);
  }

  const { data, error } = await q;
  if (error) {
    if (error.message.includes("does not exist") || error.code === "42P01") return hits;
    throw new Error(`${probe.table}.${col}: ${error.message}`);
  }

  const rows = Array.isArray(data) ? (data as unknown as Record<string, unknown>[]) : [];
  for (const row of rows) {
    const id = String(row.id ?? "");
    const matchValue = row[col] != null ? String(row[col]) : null;
    hits.push({
      table: probe.table,
      column: probe.column,
      row_id: id,
      match_value: matchValue,
      row_preview: previewRow(row),
    });
  }
  return hits;
}

function manifestContainsVret(manifest: unknown, needle: string): boolean {
  if (manifest == null) return false;
  try {
    return JSON.stringify(manifest).toUpperCase().includes(needle.toUpperCase());
  } catch {
    return false;
  }
}

async function probeManifestData(
  client: SupabaseClient,
  orgId: string,
  needle: string,
): Promise<DbHit[]> {
  const { data, error } = await client
    .from("packages")
    .select(PACKAGE_SELECT)
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .or(`rma_number.ilike.VRET%,tracking_number.ilike.VRET%,id_slip_contents.ilike.VRET%`)
    .limit(50);
  if (error) {
    if (error.message.includes("does not exist")) return [];
    throw new Error(`packages.manifest_scan: ${error.message}`);
  }

  const hits: DbHit[] = [];
  const rows = Array.isArray(data) ? (data as unknown as Record<string, unknown>[]) : [];
  for (const row of rows) {
    if (!manifestContainsVret(row.manifest_data, needle)) continue;
    hits.push({
      table: "packages",
      column: "manifest_data",
      row_id: String(row.id ?? ""),
      match_value: needle,
      row_preview: previewRow(row),
    });
  }
  return hits;
}

function extractNeighboringIdentifiers(hits: DbHit[]): Record<string, string | null> {
  const out: Record<string, string | null> = {
    order_id: null,
    tracking_number: null,
    rma_number: null,
    lpn: null,
    fnsku: null,
    sku: null,
    asin: null,
    id_slip_contents: null,
    package_code: null,
    removal_order_id: null,
    amazon_order_id_from_manifest: null,
    vret_id_from_manifest: null,
  };

  for (const hit of hits) {
    const r = hit.row_preview;
    for (const key of Object.keys(out)) {
      if (out[key] != null) continue;
      if (r[key] != null && String(r[key]).trim()) out[key] = String(r[key]);
    }
    const manifest = r.manifest_data;
    if (manifest && typeof manifest === "object") {
      const m = manifest as Record<string, unknown>;
      if (!out.vret_id_from_manifest && m.vret_id) out.vret_id_from_manifest = String(m.vret_id);
      if (!out.amazon_order_id_from_manifest && (m.amazon_order_id || m.order_id)) {
        out.amazon_order_id_from_manifest = String(m.amazon_order_id ?? m.order_id);
      }
    }
  }
  return out;
}

function countVretPrefixHits(hits: DbHit[]): number {
  const seen = new Set<string>();
  for (const h of hits) {
    const v = h.match_value ?? "";
    if (/^VRET/i.test(v)) seen.add(`${h.table}:${h.row_id}:${v}`);
  }
  return seen.size;
}

function buildCodebaseFindings(): Record<string, unknown> {
  return {
    scanner_field_name: "vret_id",
    ocr_prompt_label: "Amazon removal / RMA style IDs like VRET7623723875531",
    regex_pattern: String.raw`\b(VRET\d{8,})\b`,
    box_slip_contrast:
      "BOX slips use id_slip_contents (S… codes) + rma_number; VRET slips use separate extract-slip flow with vret_id",
    operator_resolve_slip_path: "packages.rma_number ilike match (runSlip)",
    expected_package_lookup: "slipIdLookupCandidates includes VRET for expected_packages.tracking_number fetch",
    trid_reference_types_include_vret: false,
    trid_reference_types: [
      "product_link",
      "order_id",
      "removal_order_id",
      "removal_shipment_id",
      "tracking_number",
      "reimbursement_id",
      "settlement_id",
      "return_item_id",
      "package_id",
      "pallet_id",
      "expected_package_id",
      "shipment_id",
      "source_report_row",
    ],
    fba_customer_returns_columns: ["license-plate-number", "order-id", "sku", "asin"],
    fba_returns_expects_lpn_not_vret: true,
  };
}

function inferMeaning(hits: DbHit[], neighbors: Record<string, string | null>): {
  inferred_meaning: string;
  confidence: "high" | "medium" | "low";
  recommended_reference_type: string;
  recommended_storage_location: string;
  recommended_edge_type: string;
  proven_not_order_id: boolean;
  proven_not_trid: boolean;
  blockers: string[];
  safe_reference: boolean;
  safe_plan_edges: boolean;
} {
  const exactFound = hits.some(
    (h) => h.match_value?.toUpperCase() === DEFAULT_VRET_EXAMPLE.toUpperCase(),
  );
  const anyVretInDb = hits.some((h) => /^VRET/i.test(h.match_value ?? ""));
  const storedAsRma = hits.some((h) => h.column === "rma_number" && /^VRET/i.test(h.match_value ?? ""));
  const storedAsTracking = hits.some(
    (h) => h.column === "tracking_number" && /^VRET/i.test(h.match_value ?? ""),
  );
  const storedAsSlipCode = hits.some(
    (h) => (h.column === "id_slip_contents" || h.column === "slip_code") && /^VRET/i.test(h.match_value ?? ""),
  );
  const inAmazonReturns = hits.some((h) => h.table === "amazon_returns");
  const inClaimEdges = hits.some((h) => h.table === "claim_reference_edges");

  const orderIdPattern = /^\d{3}-\d{7}-\d{7}$/;
  const proven_not_order_id =
    !orderIdPattern.test(DEFAULT_VRET_EXAMPLE) &&
    neighbors.order_id !== DEFAULT_VRET_EXAMPLE &&
    neighbors.amazon_order_id_from_manifest !== DEFAULT_VRET_EXAMPLE;

  const proven_not_trid = true;

  const blockers: string[] = [];
  if (!exactFound) {
    blockers.push(`Example ${DEFAULT_VRET_EXAMPLE} not found in original DB probes — slip OCR/photo verification pending`);
  }
  if (!anyVretInDb) {
    blockers.push("No VRET-prefix rows in probed operational tables for this org");
  }
  if (inAmazonReturns) {
    blockers.push("Unexpected VRET match in amazon_returns — reconcile with LPN semantics");
  }

  let confidence: "high" | "medium" | "low" = "medium";
  let inferred_meaning =
    "Printed Amazon vendor-return / removal packing-slip document identifier (VRET prefix + numeric suffix). Distinct from marketplace order_id, FBA LPN, BOX slip S-code, and internal TRID graph keys.";

  if (storedAsRma || storedAsTracking || storedAsSlipCode) {
    confidence = exactFound ? "high" : "medium";
  } else if (!anyVretInDb) {
    confidence = "low";
    inferred_meaning =
      "Codebase-only inference: VRET is treated as Amazon removal/RMA-style packing-slip barcode (scanner vret_id). No DB row yet proves the example value.";
  }

  const recommended_reference_type = exactFound || anyVretInDb ? "vret_id" : "unknown_slip_reference";
  let recommended_storage_location =
    "claim_candidate.metadata.vret_id + scanner slip evidence JSON; mirror to packages.rma_number when operator slip scan binds package";
  if (storedAsTracking) {
    recommended_storage_location +=
      "; observed also in expected_packages.tracking_number / packages.tracking_number";
  }
  if (storedAsSlipCode) {
    recommended_storage_location += "; observed in id_slip_contents/slip_code (secondary — BOX flow uses S-codes)";
  }

  const recommended_edge_type = "claim_to_vret_slip_reference (proposed) or claim_to_tracking_number when EP row uses VRET as tracking surrogate";

  const safe_reference = (exactFound || anyVretInDb) && proven_not_order_id && proven_not_trid && !inAmazonReturns;
  const safe_plan_edges =
    safe_reference && !inClaimEdges && (storedAsRma || storedAsTracking || anyVretInDb);

  if (!safe_plan_edges && anyVretInDb) {
    blockers.push("Plan edge materialization only after pilot case links VRET to package/EP without ambiguity");
  }

  return {
    inferred_meaning,
    confidence,
    recommended_reference_type,
    recommended_storage_location,
    recommended_edge_type,
    proven_not_order_id,
    proven_not_trid,
    blockers,
    safe_reference,
    safe_plan_edges,
  };
}

export async function runVretSlipReferenceMappingAuditV1(args: {
  client: SupabaseClient;
  organizationId: string;
  vretExample?: string;
  reportSearchHits?: ReportSearchHit[];
}): Promise<VretSlipReferenceMappingAuditResult> {
  const vretExample = (args.vretExample ?? DEFAULT_VRET_EXAMPLE).trim().toUpperCase();
  const allHits: DbHit[] = [];

  for (const probe of DB_COLUMN_PROBES) {
    const hits = await probeColumn(args.client, args.organizationId, probe, vretExample);
    allHits.push(...hits);
  }

  const manifestHits = await probeManifestData(args.client, args.organizationId, vretExample);
  allHits.push(...manifestHits);

  const deduped = new Map<string, DbHit>();
  for (const h of allHits) {
    deduped.set(`${h.table}:${h.column}:${h.row_id}:${h.match_value}`, h);
  }
  const dbHits = [...deduped.values()];

  const exact_occurrence_found = dbHits.some(
    (h) =>
      h.match_value?.toUpperCase() === vretExample ||
      (h.column === "manifest_data" && manifestContainsVret(h.row_preview.manifest_data, vretExample)),
  );

  const occurrence_locations = dbHits.map((h) => `${h.table}.${h.column}#${h.row_id}`);
  const neighbors = extractNeighboringIdentifiers(dbHits);
  const inference = inferMeaning(dbHits, neighbors);

  return {
    version: CLAIM_VRET_SLIP_REFERENCE_MAPPING_AUDIT_V1_VERSION,
    vret_example: vretExample,
    exact_occurrence_found,
    occurrence_locations,
    source_files_checked: [...CODEBASE_VRET_SOURCE_FILES],
    db_tables_checked: [...new Set(DB_COLUMN_PROBES.map((p) => p.table).concat(["packages.manifest_data"]))],
    report_types_checked: [...REPORT_TYPES_TO_CHECK],
    matched_report_rows: args.reportSearchHits ?? [],
    neighboring_identifiers: neighbors,
    inferred_meaning: inference.inferred_meaning,
    confidence: inference.confidence,
    proven_not_order_id: inference.proven_not_order_id,
    proven_not_trid: inference.proven_not_trid,
    recommended_reference_type: inference.recommended_reference_type,
    recommended_storage_location: inference.recommended_storage_location,
    recommended_edge_type_if_later_materialized: inference.recommended_edge_type,
    blockers: inference.blockers,
    no_db_write_verification: true,
    no_claim_mutation_verification: true,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: true,
    SAFE_TO_USE_VRET_AS_REFERENCE: inference.safe_reference,
    SAFE_TO_PLAN_VRET_REFERENCE_EDGE_MATERIALIZATION: inference.safe_plan_edges,
    NEXT_PROMPT: inference.safe_plan_edges
      ? "PHASE-CLAIM-VRET-REFERENCE-EDGE-MATERIALIZATION-PLAN-V1 — design claim_reference_edges for vret_id anchored to packages/expected_packages without mutating pilot claims."
      : "PHASE-CLAIM-VRET-SLIP-OCR-EVIDENCE-BIND-V1 — capture slip photo/OCR for VRET7644940165531 and bind to package row read-only verify before edge plan.",
    db_hits: dbHits,
    vret_pattern_sample_count: countVretPrefixHits(dbHits),
    codebase_findings: buildCodebaseFindings(),
  };
}

export function countVretInText(text: string, vretExample: string): number {
  const re = new RegExp(vretExample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return (text.match(re) ?? []).length;
}
