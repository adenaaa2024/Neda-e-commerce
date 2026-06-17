/**
 * PHASE-7H-SOURCE-API-FILE-REFERENCE-DISCOVERY-V1
 * Read-only trace from pilot cases → DB source rows → upload/API/file lineage.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClaimCaseReviewRow } from "../pilot/claim-case-review-readmodel";

export const SOURCE_API_FILE_REFERENCE_DISCOVERY_V1_VERSION =
  "claim-7h-source-api-file-reference-discovery-v1" as const;

export type UploadLineageRow = {
  upload_id: string;
  file_name: string | null;
  report_type: string | null;
  status: string | null;
  created_at: string | null;
  metadata: Record<string, unknown>;
  storage_paths_attempted: string[];
  storage_download_status: "downloaded" | "not_found" | "skipped" | "error";
  local_artifact_path: string | null;
  source_run_summary: Record<string, unknown> | null;
};

export type StagingLineageRow = {
  staging_id: string;
  upload_id: string | null;
  report_type: string | null;
  row_index: number | null;
  raw_data_keys: string[];
};

export type ResolvedSourceRow = {
  source_table: string;
  source_row_id: string;
  row_found: boolean;
  row: Record<string, unknown> | null;
  upload_id: string | null;
  source_staging_id: string | null;
  source_detail_row_id: string | null;
  source_shipment_row_id: string | null;
  tracking_number: string | null;
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  removal_order_row: Record<string, unknown> | null;
  removal_shipment_row: Record<string, unknown> | null;
};

export type PerCaseSourceResolution = {
  claim_case_id: string;
  claim_line_id: string | null;
  claim_candidate_id: string | null;
  family_key_v3: string | null;
  intake_run_id: string | null;
  pilot_case_run_id: string | null;
  source_table: string | null;
  source_row_id: string | null;
  source_event_key: string | null;
  source_event_date: string | null;
  source_kind: string | null;
  expected_package_id: string | null;
  tracking_reference: string | null;
  product_identifiers: {
    sku: string | null;
    fnsku: string | null;
    asin: string | null;
    resolved_product_id: string | null;
  };
  trid_from_source: string | null;
  resolved_source: ResolvedSourceRow;
  upload_lineage: UploadLineageRow | null;
  staging_lineage: StagingLineageRow | null;
  source_files_or_api_endpoints_checked: string[];
  file_verification: {
    file_available: boolean;
    source_event_key_in_file: boolean | null;
    tracking_in_file: boolean | null;
    order_id_in_file: boolean | null;
    sku_in_file: boolean | null;
    fnsku_in_file: boolean | null;
    file_contradicts_db: boolean;
  };
  expected_package_source_match: boolean;
  tracking_source_match: boolean;
  removal_order_source_match: boolean;
  removal_shipment_source_match: boolean;
  trid_source_match: boolean;
  missing_trid_warning: boolean;
  source_file_missing: boolean;
  source_metadata_missing: boolean;
  fallback_allowed: boolean;
  fallback_db_source_row_sufficient: boolean;
  source_confidence: "high" | "medium" | "low";
  warnings: string[];
  blockers: string[];
  blocked_for_7h_materialization: boolean;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function looksLikeTracking(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return /^TBA\d+/i.test(v) || /^\d{12,22}$/.test(v) || /^1Z[A-Z0-9]+$/i.test(v);
}

export function tridFromMetadata(meta: Record<string, unknown>): string | null {
  const trid = str(meta.trid);
  if (trid) return trid;
  const productLink = str(meta.product_link);
  if (productLink) return productLink;
  return null;
}

export function tridFromReferenceEdges(meta: Record<string, unknown>): string | null {
  const raw = meta.reference_edges;
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    const o = metaRecord(item);
    const kind = str(o.reference_kind);
    if (kind === "product_link" || kind === "trid") {
      const v = str(o.reference_value);
      if (v) return v;
    }
  }
  return null;
}

export function resolveUploadStoragePaths(metadata: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const rawFile = str(metadata.raw_file_path);
  if (rawFile) paths.push(rawFile);
  const prefix = str(metadata.storage_prefix);
  if (prefix) {
    for (const name of ["original.csv", "original.tsv", "original.txt", "file.csv", "file.tsv"]) {
      paths.push(`${prefix}/${name}`.replace(/\/+/g, "/"));
    }
  }
  const sr = metaRecord(metadata.source_run);
  const archive = metaRecord(sr.archive);
  const objectKey = str(archive.object_key);
  if (objectKey) paths.push(objectKey);
  return [...new Set(paths.filter(Boolean))];
}

export function textContainsNeedle(text: string, needle: string | null): boolean | null {
  if (!needle) return null;
  return text.toLowerCase().includes(needle.toLowerCase());
}

export function assessDbSourceRowSufficient(args: {
  familyKey: string | null;
  resolved: ResolvedSourceRow;
  sourceEventKey: string | null;
  candidateSourceTable: string | null;
  candidateSourceRowId: string | null;
}): boolean {
  const { resolved, familyKey, sourceEventKey, candidateSourceTable, candidateSourceRowId } = args;
  if (!resolved.row_found || !resolved.row) return false;
  if (candidateSourceTable !== "expected_packages") return false;
  if (str(resolved.source_row_id) !== str(candidateSourceRowId)) return false;

  const epTracking = str(resolved.tracking_number);
  const eventKey = str(sourceEventKey);
  const trackingOk =
    familyKey !== "removal_shipment_missing" ||
    Boolean(epTracking || (eventKey && looksLikeTracking(eventKey)));

  const orderOk =
    familyKey !== "removal_order_discrepancy" ||
    Boolean(resolved.source_detail_row_id || resolved.removal_order_row || resolved.order_id);

  const shipmentPointerOk =
    familyKey !== "removal_shipment_missing" ||
    Boolean(resolved.source_shipment_row_id || resolved.removal_shipment_row || epTracking);

  const provenanceOk = Boolean(resolved.upload_id || resolved.source_staging_id);

  return trackingOk && orderOk && shipmentPointerOk && provenanceOk;
}

export function buildPerCaseSourceResolution(args: {
  row: ClaimCaseReviewRow;
  candidate: Record<string, unknown> | null;
  resolved: ResolvedSourceRow;
  uploadLineage: UploadLineageRow | null;
  stagingLineage: StagingLineageRow | null;
  fileText: string | null;
  endpointsChecked: string[];
}): PerCaseSourceResolution {
  const line = args.row.lines[0] ?? null;
  const candMeta = metaRecord(args.candidate?.metadata);
  const removalMeta = metaRecord(args.resolved.removal_order_row?.raw_data);
  const shipmentMeta = metaRecord(args.resolved.removal_shipment_row?.raw_data);

  const trid =
    tridFromMetadata(candMeta) ||
    tridFromReferenceEdges(candMeta) ||
    tridFromMetadata(removalMeta) ||
    tridFromMetadata(shipmentMeta);

  const tracking =
    str(args.resolved.tracking_number) ||
    (looksLikeTracking(str(args.row.source_event_key)) ? str(args.row.source_event_key) : null);

  const expectedPackageId =
    args.candidate && str(args.candidate.source_table) === "expected_packages"
      ? str(args.candidate.source_row_id)
      : str(args.resolved.source_row_id);

  const expectedPackageMatch =
    args.resolved.row_found &&
    str(args.resolved.source_table) === "expected_packages" &&
    str(args.resolved.source_row_id) === expectedPackageId;

  const trackingMatch =
    args.row.family_key_v3 !== "removal_shipment_missing"
      ? false
      : Boolean(tracking) &&
        (str(args.resolved.tracking_number) === tracking ||
          str(args.row.source_event_key) === tracking);

  const removalOrderMatch =
    args.row.family_key_v3 !== "removal_order_discrepancy"
      ? false
      : Boolean(args.resolved.source_detail_row_id || args.resolved.removal_order_row);

  const removalShipmentMatch =
    args.row.family_key_v3 !== "removal_shipment_missing"
      ? false
      : Boolean(args.resolved.source_shipment_row_id || args.resolved.removal_shipment_row || tracking);

  const uploadMeta = args.uploadLineage?.metadata ?? {};
  const sourceMetadataMissing =
    !args.uploadLineage &&
    !args.stagingLineage &&
    !str(args.resolved.upload_id) &&
    !str(args.resolved.source_staging_id);

  const sourceFileMissing =
    args.uploadLineage != null &&
    args.uploadLineage.storage_download_status !== "downloaded";

  const fileText = args.fileText;
  const fileAvailable = Boolean(fileText);
  const fileVerification = {
    file_available: fileAvailable,
    source_event_key_in_file: fileText
      ? textContainsNeedle(fileText, str(args.row.source_event_key))
      : null,
    tracking_in_file: fileText ? textContainsNeedle(fileText, tracking) : null,
    order_id_in_file: fileText ? textContainsNeedle(fileText, str(args.resolved.order_id)) : null,
    sku_in_file: fileText ? textContainsNeedle(fileText, str(args.resolved.sku)) : null,
    fnsku_in_file: fileText ? textContainsNeedle(fileText, str(args.resolved.fnsku)) : null,
    file_contradicts_db: false,
  };

  if (fileAvailable) {
    const mustMatch: Array<boolean | null> = [];
    if (str(args.row.source_event_key)) mustMatch.push(fileVerification.source_event_key_in_file);
    if (tracking && args.row.family_key_v3 === "removal_shipment_missing") {
      mustMatch.push(fileVerification.tracking_in_file);
    }
    if (args.row.family_key_v3 === "removal_order_discrepancy" && str(args.resolved.order_id)) {
      mustMatch.push(fileVerification.order_id_in_file);
    }
    const checked = mustMatch.filter((v) => v !== null) as boolean[];
    if (checked.length > 0 && checked.every((v) => v === false)) {
      fileVerification.file_contradicts_db = true;
    }
  }

  const fallbackDbSufficient = assessDbSourceRowSufficient({
    familyKey: args.row.family_key_v3,
    resolved: args.resolved,
    sourceEventKey: args.row.source_event_key,
    candidateSourceTable: str(args.candidate?.source_table) || null,
    candidateSourceRowId: str(args.candidate?.source_row_id) || null,
  });

  const fallbackAllowed = sourceFileMissing && fallbackDbSufficient;

  const warnings: string[] = [];
  const blockers: string[] = [];

  if (!trid) warnings.push("missing_trid_warning");
  if (sourceMetadataMissing) warnings.push("source_metadata_missing");
  if (sourceFileMissing) warnings.push("source_file_missing");
  if (fallbackAllowed) warnings.push("fallback_db_source_row_allowed");

  if (!expectedPackageMatch) blockers.push("expected_package_source_row_not_resolved");
  if (args.row.family_key_v3 === "removal_shipment_missing" && !trackingMatch) {
    blockers.push("tracking_reference_not_resolved_in_db");
  }
  if (args.row.family_key_v3 === "removal_order_discrepancy" && !removalOrderMatch) {
    blockers.push("removal_order_reference_not_resolved_in_db");
  }
  if (args.row.family_key_v3 === "removal_shipment_missing" && !removalShipmentMatch) {
    blockers.push("removal_shipment_reference_not_resolved_in_db");
  }
  if (fileVerification.file_contradicts_db) {
    blockers.push("source_file_contradicts_db");
  }
  if (sourceFileMissing && !fallbackDbSufficient) {
    blockers.push("source_file_missing_and_db_insufficient");
  }

  let sourceConfidence: "high" | "medium" | "low" = "low";
  if (blockers.length === 0 && fileAvailable) sourceConfidence = "high";
  else if (blockers.length === 0 && fallbackDbSufficient) sourceConfidence = "medium";
  else if (fallbackDbSufficient) sourceConfidence = "medium";

  return {
    claim_case_id: args.row.id,
    claim_line_id: line?.id ?? null,
    claim_candidate_id: line?.claim_candidate_id ?? null,
    family_key_v3: args.row.family_key_v3,
    intake_run_id: args.row.intake_run_id,
    pilot_case_run_id: args.row.pilot_case_run_id,
    source_table: str(args.candidate?.source_table) || "expected_packages",
    source_row_id: str(args.candidate?.source_row_id) || expectedPackageId,
    source_event_key: args.row.source_event_key,
    source_event_date: args.row.source_event_date,
    source_kind: str(args.candidate?.source_kind) || null,
    expected_package_id: expectedPackageId,
    tracking_reference: tracking,
    product_identifiers: {
      sku: str(args.resolved.sku) || args.row.sku || null,
      fnsku: str(args.resolved.fnsku) || args.row.fnsku || null,
      asin: str(args.resolved.asin) || args.row.asin || null,
      resolved_product_id: args.row.resolved_product_id,
    },
    trid_from_source: trid,
    resolved_source: args.resolved,
    upload_lineage: args.uploadLineage,
    staging_lineage: args.stagingLineage,
    source_files_or_api_endpoints_checked: args.endpointsChecked,
    file_verification: fileVerification,
    expected_package_source_match: expectedPackageMatch,
    tracking_source_match: trackingMatch,
    removal_order_source_match: removalOrderMatch,
    removal_shipment_source_match: removalShipmentMatch,
    trid_source_match: Boolean(trid),
    missing_trid_warning: !trid,
    source_file_missing: sourceFileMissing,
    source_metadata_missing: sourceMetadataMissing,
    fallback_allowed: fallbackAllowed,
    fallback_db_source_row_sufficient: fallbackDbSufficient,
    source_confidence: sourceConfidence,
    warnings,
    blockers,
    blocked_for_7h_materialization: blockers.length > 0,
  };
}

export type SourceDiscoverySummary = {
  active_case_count: number;
  family_distribution: { removal_shipment_missing: number; removal_order_discrepancy: number };
  expected_package_source_match_count: number;
  tracking_source_match_count: number;
  removal_order_source_match_count: number;
  removal_shipment_source_match_count: number;
  trid_source_match_count: number;
  missing_trid_warning_count: number;
  missing_source_file_count: number;
  missing_source_metadata_count: number;
  fallback_db_source_row_sufficient_count: number;
  blocked_case_count: number;
  blocker_reasons: Record<string, number>;
  source_confidence_summary: Record<string, number>;
};

export function summarizeSourceDiscovery(
  reports: PerCaseSourceResolution[],
): SourceDiscoverySummary {
  const familyDist = { removal_shipment_missing: 0, removal_order_discrepancy: 0 };
  const blockerReasons: Record<string, number> = {};
  const confidenceSummary: Record<string, number> = { high: 0, medium: 0, low: 0 };

  for (const r of reports) {
    if (r.family_key_v3 === "removal_shipment_missing") familyDist.removal_shipment_missing += 1;
    if (r.family_key_v3 === "removal_order_discrepancy") familyDist.removal_order_discrepancy += 1;
    for (const b of r.blockers) blockerReasons[b] = (blockerReasons[b] ?? 0) + 1;
    confidenceSummary[r.source_confidence] = (confidenceSummary[r.source_confidence] ?? 0) + 1;
  }

  return {
    active_case_count: reports.length,
    family_distribution: familyDist,
    expected_package_source_match_count: reports.filter((r) => r.expected_package_source_match).length,
    tracking_source_match_count: reports.filter((r) => r.tracking_source_match).length,
    removal_order_source_match_count: reports.filter((r) => r.removal_order_source_match).length,
    removal_shipment_source_match_count: reports.filter((r) => r.removal_shipment_source_match).length,
    trid_source_match_count: reports.filter((r) => r.trid_source_match).length,
    missing_trid_warning_count: reports.filter((r) => r.missing_trid_warning).length,
    missing_source_file_count: reports.filter((r) => r.source_file_missing).length,
    missing_source_metadata_count: reports.filter((r) => r.source_metadata_missing).length,
    fallback_db_source_row_sufficient_count: reports.filter((r) => r.fallback_db_source_row_sufficient)
      .length,
    blocked_case_count: reports.filter((r) => r.blocked_for_7h_materialization).length,
    blocker_reasons: blockerReasons,
    source_confidence_summary: confidenceSummary,
  };
}

export async function probeExpectedPackageSelectColumns(
  client: SupabaseClient,
  organizationId: string,
): Promise<string> {
  let select = "id";
  for (const col of [
    "upload_id",
    "source_staging_id",
    "source_detail_row_id",
    "source_shipment_row_id",
    "source_shipment_row_ids",
    "tracking_number",
    "order_id",
    "sku",
    "fnsku",
    "asin",
    "store_id",
    "order_type",
    "shipped_quantity",
  ] as const) {
    const { error } = await client
      .from("expected_packages")
      .select(`id, ${col}`)
      .eq("organization_id", organizationId)
      .limit(1);
    if (!error) select += `, ${col}`;
  }
  return select;
}

export async function loadExpectedPackageSourceRow(
  client: SupabaseClient,
  organizationId: string,
  expectedPackageId: string,
  selectColumns?: string,
): Promise<ResolvedSourceRow> {
  const empty: ResolvedSourceRow = {
    source_table: "expected_packages",
    source_row_id: expectedPackageId,
    row_found: false,
    row: null,
    upload_id: null,
    source_staging_id: null,
    source_detail_row_id: null,
    source_shipment_row_id: null,
    tracking_number: null,
    order_id: null,
    sku: null,
    fnsku: null,
    asin: null,
    removal_order_row: null,
    removal_shipment_row: null,
  };
  if (!expectedPackageId) return empty;

  const select =
    selectColumns ?? (await probeExpectedPackageSelectColumns(client, organizationId));

  const { data, error } = await client
    .from("expected_packages")
    .select(select)
    .eq("organization_id", organizationId)
    .eq("id", expectedPackageId)
    .maybeSingle();
  if (error) {
    return { ...empty, row: { load_error: error.message } as Record<string, unknown> };
  }
  if (!data) return empty;

  const row = data as unknown as Record<string, unknown>;
  const shipmentIds = row.source_shipment_row_ids;
  const firstShipmentId =
    str(row.source_shipment_row_id) ||
    (Array.isArray(shipmentIds) && shipmentIds[0] ? str(shipmentIds[0]) : null);

  const resolved: ResolvedSourceRow = {
    source_table: "expected_packages",
    source_row_id: str(row.id),
    row_found: true,
    row,
    upload_id: str(row.upload_id) || null,
    source_staging_id: str(row.source_staging_id) || null,
    source_detail_row_id: str(row.source_detail_row_id) || null,
    source_shipment_row_id: firstShipmentId,
    tracking_number: str(row.tracking_number) || null,
    order_id: str(row.order_id) || null,
    sku: str(row.sku) || null,
    fnsku: str(row.fnsku) || null,
    asin: str(row.asin) || null,
    removal_order_row: null,
    removal_shipment_row: null,
  };

  if (resolved.source_detail_row_id) {
    const { data: removal } = await client
      .from("amazon_removals")
      .select("id, upload_id, source_staging_id, order_id, sku, fnsku, tracking_number, raw_data")
      .eq("organization_id", organizationId)
      .eq("id", resolved.source_detail_row_id)
      .maybeSingle();
    if (removal) resolved.removal_order_row = removal as Record<string, unknown>;
  }

  if (resolved.source_shipment_row_id) {
    const { data: shipment } = await client
      .from("amazon_removal_shipments")
      .select("id, upload_id, source_staging_id, order_id, sku, fnsku, tracking_number, raw_data")
      .eq("organization_id", organizationId)
      .eq("id", resolved.source_shipment_row_id)
      .maybeSingle();
    if (shipment) resolved.removal_shipment_row = shipment as Record<string, unknown>;
  }

  return resolved;
}

export async function loadUploadLineage(
  client: SupabaseClient,
  organizationId: string,
  uploadId: string | null,
): Promise<UploadLineageRow | null> {
  if (!uploadId) return null;
  const { data, error } = await client
    .from("raw_report_uploads")
    .select("id, file_name, report_type, status, created_at, metadata")
    .eq("organization_id", organizationId)
    .eq("id", uploadId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const metadata = metaRecord(row.metadata);
  const sr = metaRecord(metadata.source_run);
  return {
    upload_id: uploadId,
    file_name: str(row.file_name) || null,
    report_type: str(row.report_type) || null,
    status: str(row.status) || null,
    created_at: str(row.created_at) || null,
    metadata,
    storage_paths_attempted: [],
    storage_download_status: "skipped",
    local_artifact_path: null,
    source_run_summary: Object.keys(sr).length > 0 ? sr : null,
  };
}

export async function loadStagingLineage(
  client: SupabaseClient,
  organizationId: string,
  stagingId: string | null,
): Promise<StagingLineageRow | null> {
  if (!stagingId) return null;
  const { data, error } = await client
    .from("amazon_staging")
    .select("id, upload_id, report_type, row_index, raw_data")
    .eq("organization_id", organizationId)
    .eq("id", stagingId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const raw = metaRecord(row.raw_data);
  return {
    staging_id: stagingId,
    upload_id: str(row.upload_id) || null,
    report_type: str(row.report_type) || null,
    row_index: typeof row.row_index === "number" ? row.row_index : null,
    raw_data_keys: Object.keys(raw),
  };
}

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export async function tryDownloadUploadArtifact(args: {
  client: SupabaseClient;
  uploadLineage: UploadLineageRow;
  outputDir: string;
}): Promise<{ lineage: UploadLineageRow; fileText: string | null }> {
  const paths = resolveUploadStoragePaths(args.uploadLineage.metadata);
  const lineage = { ...args.uploadLineage, storage_paths_attempted: paths };

  for (const objectPath of paths) {
    const { data, error } = await args.client.storage.from("raw-reports").download(objectPath);
    if (error || !data) continue;
    const buf = Buffer.from(await data.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) {
      lineage.storage_download_status = "skipped";
      return { lineage, fileText: buf.subarray(0, MAX_DOWNLOAD_BYTES).toString("utf8") };
    }
    const safeName = objectPath.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const localPath = `${args.outputDir}/${args.uploadLineage.upload_id}_${safeName}`;
    fsWrite(localPath, buf);
    lineage.storage_download_status = "downloaded";
    lineage.local_artifact_path = localPath;
    return { lineage, fileText: buf.toString("utf8") };
  }

  lineage.storage_download_status = paths.length > 0 ? "not_found" : "skipped";
  return { lineage, fileText: null };
}

function fsWrite(filePath: string, buf: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}
