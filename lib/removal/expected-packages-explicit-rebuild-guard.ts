import type { ImportRunMetrics } from "../raw-report-upload-metadata";

/** True when pipeline hook already recorded rebuild for this upload (idempotent metadata). */
export function expectedPackagesRebuildRecordedForUpload(
  metadata: unknown,
  uploadId: string,
): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const im = (metadata as Record<string, unknown>).import_metrics;
  if (!im || typeof im !== "object") return false;
  const prior = (im as ImportRunMetrics).expected_packages_rebuild_after_import;
  if (!prior || typeof prior !== "object") return false;
  return prior.upload_id === uploadId && prior.rebuild_called === true;
}

export type ExplicitRebuildSkipDecision = {
  skip: boolean;
  reason: string | null;
  covered_upload_id: string | null;
};

/**
 * Skip redundant explicit `rebuild_expected_packages_from_removals` when the Reports API
 * pipeline hook already rebuilt for a successful import in this session.
 * Manual / fetch-only paths (no successful pipeline) still run explicit rebuild.
 */
export function evaluateExplicitRebuildSkip(params: {
  rebuildExpectedPackages: boolean;
  orderPipelineOk: boolean | null | undefined;
  shipmentPipelineOk: boolean | null | undefined;
  orderUploadMetadata: unknown;
  shipmentUploadMetadata: unknown;
  orderUploadId: string | null | undefined;
  shipmentUploadId: string | null | undefined;
}): ExplicitRebuildSkipDecision {
  if (params.rebuildExpectedPackages === false) {
    return { skip: true, reason: "rebuild_disabled", covered_upload_id: null };
  }

  const anyPipelineOk = params.orderPipelineOk === true || params.shipmentPipelineOk === true;
  if (!anyPipelineOk) {
    return { skip: false, reason: null, covered_upload_id: null };
  }

  const shipmentId = params.shipmentUploadId?.trim() || null;
  const orderId = params.orderUploadId?.trim() || null;

  if (params.shipmentPipelineOk && shipmentId) {
    if (expectedPackagesRebuildRecordedForUpload(params.shipmentUploadMetadata, shipmentId)) {
      return {
        skip: true,
        reason: "pipeline_hook_already_rebuilt",
        covered_upload_id: shipmentId,
      };
    }
  }

  if (params.orderPipelineOk && orderId) {
    if (expectedPackagesRebuildRecordedForUpload(params.orderUploadMetadata, orderId)) {
      return {
        skip: true,
        reason: "pipeline_hook_already_rebuilt",
        covered_upload_id: orderId,
      };
    }
  }

  return { skip: false, reason: null, covered_upload_id: null };
}

async function loadUploadMetadata(
  client: import("pg").Client,
  organizationId: string,
  uploadId: string | null | undefined,
): Promise<unknown> {
  if (!uploadId?.trim()) return null;
  const r = await client.query(
    `SELECT metadata FROM public.raw_report_uploads WHERE id=$1::uuid AND organization_id=$2::uuid`,
    [uploadId.trim(), organizationId],
  );
  return (r.rows[0] as { metadata?: unknown } | undefined)?.metadata ?? null;
}

export async function evaluateExplicitRebuildSkipFromDb(params: {
  client: import("pg").Client;
  organizationId: string;
  rebuildExpectedPackages: boolean;
  orderPipelineOk: boolean | null | undefined;
  shipmentPipelineOk: boolean | null | undefined;
  orderUploadId: string | null | undefined;
  shipmentUploadId: string | null | undefined;
}): Promise<ExplicitRebuildSkipDecision> {
  const [orderMeta, shipmentMeta] = await Promise.all([
    loadUploadMetadata(params.client, params.organizationId, params.orderUploadId),
    loadUploadMetadata(params.client, params.organizationId, params.shipmentUploadId),
  ]);
  return evaluateExplicitRebuildSkip({
    rebuildExpectedPackages: params.rebuildExpectedPackages,
    orderPipelineOk: params.orderPipelineOk,
    shipmentPipelineOk: params.shipmentPipelineOk,
    orderUploadMetadata: orderMeta,
    shipmentUploadMetadata: shipmentMeta,
    orderUploadId: params.orderUploadId,
    shipmentUploadId: params.shipmentUploadId,
  });
}
