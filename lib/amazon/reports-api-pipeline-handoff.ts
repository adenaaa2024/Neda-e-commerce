import "server-only";

import { executeAmazonPhase2Staging } from "../pipeline/amazon-phase2-staging";
import { syncFinancialReferenceResolverForUpload } from "../financial-reference-resolver-sync";
import { mergeUploadMetadata, parseRawReportMetadata } from "../raw-report-upload-metadata";
import { supabaseServer } from "../supabase-server";
import {
  resolveAmazonImportEngineConfig,
  resolveAmazonImportSyncKind,
  requiresPhase4Generic,
} from "../pipeline/amazon-report-registry";
import { isUuidString } from "../uuid";
import type { SourceRunState } from "./reports-api-source-run";
import { patchSourceRun } from "./reports-api-source-run";
import {
  assessReportsApiPipelineCompletion,
  resolvePipelineEntryState,
} from "./reports-api-pipeline-completion";
import { mergeSourceRunIntoMetadata } from "./reports-api-source-run";

function resolveInternalAppBaseUrl(): string {
  const explicit = process.env.REPORTS_API_INTERNAL_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (site) return site.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  return "http://127.0.0.1:3000";
}

async function postImportRoute(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  if (process.env.REPORTS_API_PIPELINE_USE_HTTP !== "true") {
    return postImportRouteInProcess(path, body);
  }
  const url = `${resolveInternalAppBaseUrl()}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    let json: Record<string, unknown> | null = null;
    try {
      const parsed = (await res.json()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        json = parsed as unknown as Record<string, unknown>;
      }
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  } catch {
    return postImportRouteInProcess(path, body);
  }
}

/** Worker/smoke scripts often run without Next listening — invoke route handlers directly. */
async function postImportRouteInProcess(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  const req = new Request(`http://reports-api-internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const res =
    path === "/api/settings/imports/sync"
      ? await import("../../app/api/settings/imports/sync/route").then((m) => m.POST(req))
      : path === "/api/settings/imports/generic"
        ? await import("../../app/api/settings/imports/generic/route").then((m) => m.POST(req))
        : null;
  if (!res) return { ok: false, status: 0, json: null };
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      json = parsed as unknown as Record<string, unknown>;
    }
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

async function patchUploadSourceRun(
  uploadId: string,
  organizationId: string,
  sourceRun: ReturnType<typeof patchSourceRun>,
): Promise<void> {
  const { data: row } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata")
    .eq("id", uploadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const metadata = mergeSourceRunIntoMetadata(row?.metadata, sourceRun);
  await supabaseServer
    .from("raw_report_uploads")
    .update({ metadata })
    .eq("id", uploadId)
    .eq("organization_id", organizationId);
}

export type PipelineHandoffResult =
  | { ok: true; state: SourceRunState }
  | { ok: false; state: SourceRunState; error: string; error_code: string };

/**
 * Runs process → sync → generic for a synthetic reimbursements upload.
 * Does not touch claims tables.
 */
export async function runReportsApiImportPipeline(params: {
  uploadId: string;
  organizationId: string;
  sourceRun: import("./reports-api-source-run").SourceRunV1;
  importFullFile?: boolean;
}): Promise<PipelineHandoffResult> {
  if (!isUuidString(params.uploadId) || !isUuidString(params.organizationId)) {
    return { ok: false, state: "failed", error: "Invalid upload or organization id.", error_code: "invalid_ids" };
  }

  let sr = params.sourceRun;

  const { data: uploadRow0 } = await supabaseServer
    .from("raw_report_uploads")
    .select("report_type")
    .eq("id", params.uploadId)
    .maybeSingle();
  const reportType0 = String((uploadRow0 as { report_type?: string } | null)?.report_type ?? "");
  const completion0 = await assessReportsApiPipelineCompletion(
    supabaseServer,
    params.organizationId,
    params.uploadId,
    reportType0,
  );
  const entryState = resolvePipelineEntryState(sr.state, completion0);
  if (entryState !== sr.state) {
    sr = patchSourceRun(sr, { state: entryState });
    await patchUploadSourceRun(params.uploadId, params.organizationId, sr);
  }

  if (sr.state === "synthetic_upload_ready" || sr.state === "staging") {
    sr = patchSourceRun(sr, { state: "staging" });
    await patchUploadSourceRun(params.uploadId, params.organizationId, sr);

    const stageRes = await executeAmazonPhase2Staging({
      upload_id: params.uploadId,
      import_full_file: params.importFullFile ?? true,
    });
    const stageJson = (await stageRes.json().catch(() => null)) as unknown as Record<string, unknown> | null;
    if (!stageRes.ok || stageJson?.ok === false) {
      const msg = String(stageJson?.error ?? "Phase 2 staging failed.");
      sr = patchSourceRun(sr, {
        state: "failed",
        attempt: {
          last_error_code: "process_failed",
          count: sr.attempt.count + 1,
          next_retry_at: null,
        },
      });
      await patchUploadSourceRun(params.uploadId, params.organizationId, sr);
      return { ok: false, state: sr.state, error: msg, error_code: "process_failed" };
    }
    sr = patchSourceRun(sr, { state: "syncing" });
    await patchUploadSourceRun(params.uploadId, params.organizationId, sr);
  }

  if (sr.state === "syncing") {
    const syncRes = await postImportRoute("/api/settings/imports/sync", {
      upload_id: params.uploadId,
    });
    if (!syncRes.ok || syncRes.json?.ok === false) {
      const msg = String(syncRes.json?.error ?? "Phase 3 sync failed.");
      sr = patchSourceRun(sr, {
        state: "failed",
        attempt: {
          last_error_code: "sync_failed",
          count: sr.attempt.count + 1,
          next_retry_at: null,
        },
      });
      await patchUploadSourceRun(params.uploadId, params.organizationId, sr);
      return { ok: false, state: sr.state, error: msg, error_code: "sync_failed" };
    }

    const { data: uploadRow } = await supabaseServer
      .from("raw_report_uploads")
      .select("report_type")
      .eq("id", params.uploadId)
      .maybeSingle();
    const reportType = String((uploadRow as { report_type?: string } | null)?.report_type ?? "");
    const kind = resolveAmazonImportSyncKind(reportType);
    const needsGeneric = requiresPhase4Generic(kind);
    sr = patchSourceRun(sr, { state: needsGeneric ? "generic" : "complete" });
    await patchUploadSourceRun(params.uploadId, params.organizationId, sr);
  }

  if (sr.state === "generic") {
    const { data: uploadRow } = await supabaseServer
      .from("raw_report_uploads")
      .select("report_type, metadata, organization_id")
      .eq("id", params.uploadId)
      .maybeSingle();
    const reportType = String((uploadRow as { report_type?: string } | null)?.report_type ?? "");
    const kind = resolveAmazonImportSyncKind(reportType);
    const cfg = resolveAmazonImportEngineConfig(kind);

    if (cfg.generic_target_table === "financial_reference_resolver") {
      try {
        await syncFinancialReferenceResolverForUpload(
          supabaseServer,
          params.organizationId,
          params.uploadId,
          kind,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Phase 4 generic failed.";
        sr = patchSourceRun(sr, {
          state: "failed",
          attempt: {
            last_error_code: "generic_failed",
            count: sr.attempt.count + 1,
            next_retry_at: null,
          },
        });
        await patchUploadSourceRun(params.uploadId, params.organizationId, sr);
        return { ok: false, state: sr.state, error: msg, error_code: "generic_failed" };
      }
    } else {
      const genericRes = await postImportRoute("/api/settings/imports/generic", {
        upload_id: params.uploadId,
      });
      if (!genericRes.ok || genericRes.json?.ok === false) {
        const msg = String(genericRes.json?.error ?? "Phase 4 generic failed.");
        sr = patchSourceRun(sr, {
          state: "failed",
          attempt: {
            last_error_code: "generic_failed",
            count: sr.attempt.count + 1,
            next_retry_at: null,
          },
        });
        await patchUploadSourceRun(params.uploadId, params.organizationId, sr);
        return { ok: false, state: sr.state, error: msg, error_code: "generic_failed" };
      }
    }

    const completionAfterGeneric = await assessReportsApiPipelineCompletion(
      supabaseServer,
      params.organizationId,
      params.uploadId,
      reportType0,
    );
    if (completionAfterGeneric.needs_domain_sync) {
      sr = patchSourceRun(sr, {
        state: "failed",
        attempt: {
          last_error_code: "domain_sync_incomplete",
          count: sr.attempt.count + 1,
          next_retry_at: null,
        },
      });
      await patchUploadSourceRun(params.uploadId, params.organizationId, sr);
      return {
        ok: false,
        state: sr.state,
        error: "Domain sync incomplete: staging rows remain with zero domain rows.",
        error_code: "domain_sync_incomplete",
      };
    }

    sr = patchSourceRun(sr, { state: "complete" });
    await patchUploadSourceRun(params.uploadId, params.organizationId, sr);
    await supabaseServer
      .from("raw_report_uploads")
      .update({
        metadata: mergeUploadMetadata(
          (await supabaseServer.from("raw_report_uploads").select("metadata").eq("id", params.uploadId).maybeSingle())
            .data?.metadata,
          {
            import_metrics: { current_phase: "complete" },
          },
        ),
      })
      .eq("id", params.uploadId);
  }

  if (sr.state === "complete") {
    const completionFinal = await assessReportsApiPipelineCompletion(
      supabaseServer,
      params.organizationId,
      params.uploadId,
      reportType0,
    );
    if (completionFinal.needs_domain_sync) {
      return {
        ok: false,
        state: "failed",
        error: "Source run complete but domain sync missing.",
        error_code: "domain_sync_incomplete",
      };
    }
    return { ok: true, state: "complete" };
  }

  return {
    ok: false,
    state: sr.state,
    error: `Unexpected pipeline state: ${sr.state}`,
    error_code: "pipeline_state",
  };
}
