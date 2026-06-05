/**
 * Production removal shipment sync — fetch → domain import → rebuild expected_packages.
 * No product inserts. No settlements/reimbursements.
 */
import { createRequire, type Module } from "node:module";
import pg from "pg";

import {
  buildRemovalOrderIdempotencyKey,
  buildRemovalShipmentIdempotencyKey,
  parseSourceRun,
} from "./amazon/reports-api-source-run";
import { queryEpAllocationMismatchBreakdown, rebuildValidFromBreakdown } from "./removal/ep-allocation-mismatch-breakdown";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "./production-db-bind";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

export const PRODUCTION_ORG_ID = "00000000-0000-0000-0000-000000000001";
export const PRODUCTION_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

export type SyncCounts = {
  removals: number;
  shipments: number;
  expected_packages_derived: number;
  return_items: number;
  packages: number;
};

export type SyncWindow = { start: string; end: string };

export function syncWindowThroughToday(rollingDays = 30): SyncWindow {
  const end = new Date();
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - rollingDays);
  start.setUTCHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function loadSyncCounts(client: pg.Client, orgId: string): Promise<SyncCounts> {
  const r = await client.query(
    `SELECT
       (SELECT count(*)::bigint FROM amazon_removals WHERE organization_id=$1::uuid) AS removals,
       (SELECT count(*)::bigint FROM amazon_removal_shipments WHERE organization_id=$1::uuid) AS shipments,
       (SELECT count(*)::bigint FROM expected_packages WHERE organization_id=$1::uuid
          AND build_source IN ('detail_shipment','detail_remainder')) AS ep_derived,
       (SELECT count(*)::bigint FROM return_items WHERE organization_id=$1::uuid AND deleted_at IS NULL) AS ri,
       (SELECT count(*)::bigint FROM packages WHERE organization_id=$1::uuid AND deleted_at IS NULL) AS pkg`,
    [orgId],
  );
  const row = r.rows[0] as Record<string, string>;
  return {
    removals: Number(row.removals),
    shipments: Number(row.shipments),
    expected_packages_derived: Number(row.ep_derived),
    return_items: Number(row.ri),
    packages: Number(row.pkg),
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchUntilReady(
  runWorker: (req: {
    organizationId: string;
    storeId: string;
    windowStart: string;
    windowEnd: string;
    uploadId: string | null;
  }) => Promise<{ upload_id: string | null; state: string; needs_resume?: boolean; error?: string }>,
  window: SyncWindow,
): Promise<{ upload_id: string | null; ok: boolean; state: string; error?: string }> {
  let uploadId: string | null = null;
  let lastState = "unknown";
  let lastError: string | undefined;
  for (let i = 0; i < 120; i++) {
    const last = await runWorker({
      organizationId: PRODUCTION_ORG_ID,
      storeId: PRODUCTION_STORE_ID,
      windowStart: window.start,
      windowEnd: window.end,
      uploadId,
    });
    uploadId = last.upload_id;
    lastState = last.state;
    lastError = last.error;
    if (last.state === "failed") break;
    if (last.state === "synthetic_upload_ready" || last.state === "complete") break;
    if (!last.needs_resume) break;
    await sleep(5000);
  }
  const ok = lastState === "synthetic_upload_ready" || lastState === "complete";
  return { upload_id: uploadId, ok, state: lastState, error: lastError };
}

async function runImportPipeline(uploadId: string): Promise<{ ok: boolean; state: string; error?: string }> {
  const { supabaseServer } = await import("./supabase-server");
  const { runReportsApiImportPipeline } = await import("./amazon/reports-api-pipeline-handoff");
  const { data } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata")
    .eq("id", uploadId)
    .eq("organization_id", PRODUCTION_ORG_ID)
    .maybeSingle();
  const sr = parseSourceRun((data as { metadata?: unknown } | null)?.metadata);
  if (!sr) return { ok: false, state: "failed", error: "missing_source_run" };
  const pipe = await runReportsApiImportPipeline({
    uploadId,
    organizationId: PRODUCTION_ORG_ID,
    sourceRun: sr,
    importFullFile: true,
  });
  return { ok: pipe.ok, state: pipe.state, error: pipe.ok ? undefined : pipe.error };
}

export type ProductionRemovalSyncResult = {
  target_ref: string;
  window: SyncWindow;
  counts_before: SyncCounts;
  counts_after: SyncCounts;
  order_fetch: { upload_id: string | null; ok: boolean; state: string; error?: string };
  shipment_fetch: { upload_id: string | null; ok: boolean; state: string; error?: string };
  order_pipeline: { ok: boolean; state: string; error?: string } | null;
  shipment_pipeline: { ok: boolean; state: string; error?: string } | null;
  rebuild: Record<string, unknown> | null;
  rebuild_valid: boolean;
  products_unchanged: boolean;
  pim_unchanged: boolean;
  latest_shipment_date: string | null;
  errors: string[];
};

export async function runProductionRemovalSync(opts: {
  window?: SyncWindow;
  skipFetch?: boolean;
  orderUploadId?: string | null;
  shipmentUploadId?: string | null;
}): Promise<ProductionRemovalSyncResult> {
  bindProductionSupabaseEnv();
  process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
  process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER = "true";
  process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT = "true";

  const window = opts.window ?? syncWindowThroughToday(30);
  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '1800s'");

  const countsBefore = await loadSyncCounts(client, PRODUCTION_ORG_ID);
  const productsBefore = Number(
    (await client.query(`SELECT count(*)::bigint c FROM products`)).rows[0]?.c ?? 0,
  );
  const pimBefore = Number(
    (await client.query(`SELECT count(*)::bigint c FROM product_identifier_map`)).rows[0]?.c ?? 0,
  );

  const errors: string[] = [];
  let orderFetch: ProductionRemovalSyncResult["order_fetch"] = {
    upload_id: opts.orderUploadId ?? null,
    ok: Boolean(opts.skipFetch),
    state: opts.skipFetch ? "skipped" : "pending",
  };
  let shipmentFetch: ProductionRemovalSyncResult["shipment_fetch"] = {
    upload_id: opts.shipmentUploadId ?? null,
    ok: Boolean(opts.skipFetch),
    state: opts.skipFetch ? "skipped" : "pending",
  };

  if (!opts.skipFetch) {
    const { runRemovalOrderReportsWorker } = await import("./amazon/reports-api-removal-order-worker");
    const { runRemovalShipmentReportsWorker } = await import("./amazon/reports-api-removal-shipment-worker");
    orderFetch = await fetchUntilReady(
      (req) =>
        runRemovalOrderReportsWorker(req, { runPipeline: false, requestBudgetMs: 55_000 }).then((r) => ({
          upload_id: r.upload_id,
          state: r.state ?? "unknown",
          needs_resume: r.needs_resume,
          error: r.error,
        })),
      window,
    );
    shipmentFetch = await fetchUntilReady(
      (req) =>
        runRemovalShipmentReportsWorker(req, { runPipeline: false, requestBudgetMs: 55_000 }).then((r) => ({
          upload_id: r.upload_id,
          state: r.state ?? "unknown",
          needs_resume: r.needs_resume,
          error: r.error,
        })),
      window,
    );
    if (!orderFetch.ok) errors.push(`order_fetch: ${orderFetch.error ?? orderFetch.state}`);
    if (!shipmentFetch.ok) errors.push(`shipment_fetch: ${shipmentFetch.error ?? shipmentFetch.state}`);
  }

  let orderPipeline: ProductionRemovalSyncResult["order_pipeline"] = null;
  let shipmentPipeline: ProductionRemovalSyncResult["shipment_pipeline"] = null;

  if (orderFetch.upload_id && orderFetch.ok) {
    orderPipeline = await runImportPipeline(orderFetch.upload_id);
    if (!orderPipeline.ok) errors.push(`order_pipeline: ${orderPipeline.error ?? orderPipeline.state}`);
  }
  if (shipmentFetch.upload_id && shipmentFetch.ok) {
    shipmentPipeline = await runImportPipeline(shipmentFetch.upload_id);
    if (!shipmentPipeline.ok) errors.push(`shipment_pipeline: ${shipmentPipeline.error ?? shipmentPipeline.state}`);
  }

  let rebuild: Record<string, unknown> | null = null;
  let rebuildValid = false;
  if (shipmentPipeline?.ok || opts.skipFetch) {
    const rebuildRes = await client.query(
      `SELECT * FROM public.rebuild_expected_packages_from_removals($1::uuid, $2::uuid)`,
      [PRODUCTION_ORG_ID, PRODUCTION_STORE_ID],
    );
    rebuild = (rebuildRes.rows[0] as Record<string, unknown>) ?? null;
    const breakdown = await queryEpAllocationMismatchBreakdown(client, PRODUCTION_ORG_ID, PRODUCTION_STORE_ID);
    rebuildValid = rebuildValidFromBreakdown(breakdown);
    if (!rebuildValid) {
      errors.push(
        `rebuild_verify: non_overflow=${breakdown.non_overflow} total=${breakdown.total}`,
      );
    }
  }

  const countsAfter = await loadSyncCounts(client, PRODUCTION_ORG_ID);
  const productsAfter = Number(
    (await client.query(`SELECT count(*)::bigint c FROM products`)).rows[0]?.c ?? 0,
  );
  const pimAfter = Number(
    (await client.query(`SELECT count(*)::bigint c FROM product_identifier_map`)).rows[0]?.c ?? 0,
  );
  const latestShip = await client.query(
    `SELECT max(shipment_date)::text AS d FROM amazon_removal_shipments WHERE organization_id=$1::uuid`,
    [PRODUCTION_ORG_ID],
  );

  const productsUnchanged = productsAfter === productsBefore;
  const pimUnchanged = pimAfter === pimBefore;
  if (!productsUnchanged) errors.push(`products count changed ${productsBefore}→${productsAfter}`);
  if (!pimUnchanged) errors.push(`product_identifier_map count changed ${pimBefore}→${pimAfter}`);
  if (countsAfter.return_items !== countsBefore.return_items) {
    errors.push(`return_items changed ${countsBefore.return_items}→${countsAfter.return_items}`);
  }
  if (countsAfter.packages !== countsBefore.packages) {
    errors.push(`packages changed ${countsBefore.packages}→${countsAfter.packages}`);
  }

  await client.end();

  return {
    target_ref: PRODUCTION_REF,
    window,
    counts_before: countsBefore,
    counts_after: countsAfter,
    order_fetch: orderFetch,
    shipment_fetch: shipmentFetch,
    order_pipeline: orderPipeline,
    shipment_pipeline: shipmentPipeline,
    rebuild,
    rebuild_valid: rebuildValid,
    products_unchanged: productsUnchanged,
    pim_unchanged: pimUnchanged,
    latest_shipment_date: (latestShip.rows[0] as { d?: string })?.d ?? null,
    errors,
  };
}
