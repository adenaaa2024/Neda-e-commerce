import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DOMAIN_TABLE,
  resolveAmazonImportSyncKind,
  type AmazonSyncKind,
} from "../pipeline/amazon-report-registry";
import type { SourceRunState } from "./reports-api-source-run";

export type ReportsApiPipelineCompletion = {
  upload_id: string;
  organization_id: string;
  kind: AmazonSyncKind;
  upload_status: string;
  domain_table: string | null;
  staging_rows: number;
  domain_rows: number;
  domain_complete: boolean;
  /** Staged rows remain but domain table empty — Phase 3 never landed. */
  needs_domain_sync: boolean;
};

export async function assessReportsApiPipelineCompletion(
  supabase: SupabaseClient,
  organizationId: string,
  uploadId: string,
  reportType: string,
): Promise<ReportsApiPipelineCompletion> {
  const kind = resolveAmazonImportSyncKind(reportType);
  const domainTable = DOMAIN_TABLE[kind];

  const { data: upload, error: upErr } = await supabase
    .from("raw_report_uploads")
    .select("status")
    .eq("id", uploadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (upErr) throw new Error(`assess pipeline: upload read failed: ${upErr.message}`);

  const uploadStatus = String((upload as { status?: string } | null)?.status ?? "");

  const { count: stagingRows, error: stErr } = await supabase
    .from("amazon_staging")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("upload_id", uploadId);
  if (stErr) throw new Error(`assess pipeline: staging count failed: ${stErr.message}`);

  let domainRows = 0;
  if (domainTable) {
    const { count, error: domErr } = await supabase
      .from(domainTable)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("upload_id", uploadId);
    if (domErr) throw new Error(`assess pipeline: domain count failed: ${domErr.message}`);
    domainRows = count ?? 0;
  }

  const stagedN = stagingRows ?? 0;
  const domainN = domainRows;
  const needsDomainSync = stagedN > 0 && domainN === 0 && domainTable != null;
  const domainComplete =
    domainTable == null
      ? uploadStatus === "complete" || uploadStatus === "raw_synced"
      : domainN > 0 && (stagedN === 0 || uploadStatus === "raw_synced" || uploadStatus === "complete");

  return {
    upload_id: uploadId,
    organization_id: organizationId,
    kind,
    upload_status: uploadStatus,
    domain_table: domainTable,
    staging_rows: stagedN,
    domain_rows: domainN,
    domain_complete: domainComplete,
    needs_domain_sync: needsDomainSync,
  };
}

/** Rewind terminal source_run when upload is still staged with no domain rows. */
export function resolvePipelineEntryState(
  sourceRunState: SourceRunState,
  assessment: Pick<ReportsApiPipelineCompletion, "needs_domain_sync" | "upload_status" | "domain_rows">,
): SourceRunState {
  if (!assessment.needs_domain_sync) return sourceRunState;

  if (sourceRunState === "complete" || sourceRunState === "generic") {
    return assessment.domain_rows > 0 ? "generic" : "syncing";
  }
  if (sourceRunState === "staging" && assessment.upload_status === "staged") {
    return "syncing";
  }
  return sourceRunState;
}
