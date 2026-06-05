/**
 * Inspect + recover failed REMOVAL_SHIPMENT upload on production (original).
 *
 *   npx tsx scripts/production-sync-failed-upload-recovery.ts --run-id=<UTC>
 *   npx tsx scripts/production-sync-failed-upload-recovery.ts --run-id=<UTC> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import {
  bindProductionSupabaseEnv,
  PRODUCTION_REF,
  productionPostgresUrl,
} from "../lib/production-db-bind";
import {
  queryEpAllocationMismatchBreakdown,
  rebuildValidFromBreakdown,
} from "../lib/removal/ep-allocation-mismatch-breakdown";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/production-sync-failed-upload-recovery";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const failedUploads = await client.query(
    `SELECT id::text, report_type, status, created_at::text, updated_at::text,
            import_pipeline_completed_at::text, metadata
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type = 'REMOVAL_SHIPMENT'
       AND status = 'failed'
     ORDER BY created_at DESC
     LIMIT 5`,
    [ORG_ID],
  );

  const latestShipment = failedUploads.rows[0] as
    | {
        id: string;
        report_type: string;
        status: string;
        created_at: string;
        metadata: Record<string, unknown>;
      }
    | undefined;

  let inspection: Record<string, unknown> = { failed_uploads: failedUploads.rows };

  if (latestShipment) {
    const uploadId = latestShipment.id;
    const shipCount = await client.query(
      `SELECT count(*)::int AS n FROM amazon_removal_shipments
       WHERE organization_id = $1::uuid AND upload_id = $2::uuid`,
      [ORG_ID, uploadId],
    );
    const fps = await client.query(
      `SELECT status, phase4_status, error_message, phase4_completed_at::text
       FROM file_processing_status WHERE upload_id = $1::uuid`,
      [uploadId],
    );
    const maxShip = await client.query(
      `SELECT max(shipment_date)::text AS d, count(*)::int AS n
       FROM amazon_removal_shipments WHERE organization_id = $1::uuid`,
      [ORG_ID],
    );
    const epDelta = await client.query(
      `SELECT count(*)::int AS n FROM expected_packages
       WHERE organization_id = $1::uuid AND build_source IN ('detail_shipment','detail_remainder')`,
      [ORG_ID],
    );
    const breakdown = await queryEpAllocationMismatchBreakdown(client, ORG_ID, STORE_ID);
    const rebuildValid = rebuildValidFromBreakdown(breakdown);

    const meta = (latestShipment.metadata ?? {}) as Record<string, unknown>;
    const errorMsg = String(meta.error_message ?? meta.failed_phase ?? "");

    inspection = {
      ...inspection,
      target_upload_id: uploadId,
      upload_created_at: latestShipment.created_at,
      metadata_error: errorMsg,
      shipments_for_upload: (shipCount.rows[0] as { n: number }).n,
      domain_shipments_total: maxShip.rows[0],
      expected_packages_derived: (epDelta.rows[0] as { n: number }).n,
      file_processing_status: fps.rows[0] ?? null,
      rebuild_valid: rebuildValid,
      breakdown,
      recovery_eligible:
        (shipCount.rows[0] as { n: number }).n > 0 &&
        rebuildValid &&
        /timeout|phase.?4|generic/i.test(errorMsg + JSON.stringify(meta)),
    };
  }

  let statusUpdated = false;
  if (apply && latestShipment && inspection.recovery_eligible) {
    const uploadId = latestShipment.id;
    const prevMeta = (latestShipment.metadata ?? {}) as Record<string, unknown>;
    const mergedMeta = {
      ...prevMeta,
      recovery_audit: {
        recovered_at: new Date().toISOString(),
        recovered_by: "production-sync-failed-upload-recovery",
        prior_status: "failed",
        prior_error_message: prevMeta.error_message ?? null,
        note: "Phase 4 timed out in Vercel route; domain import and manual rebuild succeeded. Status set to synced.",
      },
      error_message: "",
      etl_phase: "complete",
      import_metrics: { ...(prevMeta.import_metrics as object), current_phase: "complete" },
    };
    delete (mergedMeta as Record<string, unknown>).failed_phase;

    const preimage = await client.query(
      `SELECT id::text, status, metadata, import_pipeline_completed_at::text, updated_at::text
       FROM raw_report_uploads WHERE id = $1::uuid`,
      [uploadId],
    );
    fs.writeFileSync(path.join(outDir, "preimage-upload.json"), JSON.stringify(preimage.rows[0], null, 2));

    await client.query("BEGIN");
    try {
      await client.query(
        `UPDATE public.raw_report_uploads
         SET status = 'synced',
             import_pipeline_completed_at = COALESCE(import_pipeline_completed_at, now()),
             metadata = $2::jsonb,
             updated_at = now()
         WHERE id = $1::uuid AND organization_id = $3::uuid AND status = 'failed'`,
        [uploadId, JSON.stringify(mergedMeta), ORG_ID],
      );
      await client.query(
        `UPDATE public.file_processing_status
         SET status = 'complete', phase4_status = 'complete', error_message = NULL,
             phase4_completed_at = COALESCE(phase4_completed_at, now()),
             phase4_generic_pct = 100
         WHERE upload_id = $1::uuid`,
        [uploadId],
      );
      await client.query("COMMIT");
      statusUpdated = true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }

    const rollbackSql = `-- rollback upload ${uploadId}
UPDATE public.raw_report_uploads
SET status = 'failed', metadata = '${JSON.stringify(latestShipment.metadata).replace(/'/g, "''")}'::jsonb, updated_at = now()
WHERE id = '${uploadId}'::uuid;
`;
    fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackSql);
  }

  await client.end();

  const manifest = {
    prompt: "PRODUCTION_SYNC_FAILED_UPLOAD_RECOVERY",
    run_id: runId,
    target_ref: PRODUCTION_REF,
    mode: apply ? "apply" : "dry_run",
    failed_upload_recovery_status: latestShipment
      ? inspection.recovery_eligible
        ? "eligible_for_synced_recovery"
        : "not_eligible_review_manually"
      : "no_failed_removal_shipment_upload",
    status_updated: statusUpdated,
    inspection,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
