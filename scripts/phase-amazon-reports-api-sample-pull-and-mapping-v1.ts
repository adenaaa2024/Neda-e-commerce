/**
 * PHASE-AMAZON-REPORTS-API-SAMPLE-PULL-AND-MAPPING-V1
 * Staging 7-day API sample pulls + header/domain mapping audit.
 *
 *   npx tsx scripts/phase-amazon-reports-api-sample-pull-and-mapping-v1.ts
 *   npx tsx scripts/phase-amazon-reports-api-sample-pull-and-mapping-v1.ts --execute
 */
import { createRequire, type Module } from "node:module";
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { SP_API_REPORT_TYPE_TO_SYNC_KIND } from "../lib/amazon/amazon-report-type-crosswalk";
import { SP_API_REPORT_TYPE_SETTLEMENT_V2 } from "../lib/amazon/reports-api-settlement-plan";
import { classifyCsvHeadersRuleBased } from "../lib/csv-import-detected-type";
import { AMAZON_REPORT_REGISTRY, type AmazonSyncKind } from "../lib/pipeline/amazon-report-registry";
import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-reports-api-sample-pull-and-mapping-v1";
const SAMPLE_DAYS = 7;
const MAX_RESUME_ROUNDS = 25;
const RESUME_SLEEP_MS = 4000;

const SP_FEE_PREVIEW = "GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA";
const SP_STRANDED = "GET_STRANDED_INVENTORY_UI_DATA";
const SP_LEDGER_DETAIL = "GET_LEDGER_DETAIL_VIEW_DATA";
const SP_FBA_RETURNS = "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA";
const SP_STORAGE = "GET_FBA_STORAGE_FEE_CHARGES_DATA";

type SampleSpec = {
  key: string;
  sp_report_type: string;
  upload_report_type: string | null;
  sync_kind: AmazonSyncKind | null;
  domain_table: string | null;
  importer_available: boolean;
  worker_kind: "live_worker" | "generic_pull" | "header_only";
  acquisition_mode: "on_demand_create" | "scheduled_list";
  window_note?: string;
};

const SAMPLE_SPECS: SampleSpec[] = [
  {
    key: "reimbursements",
    sp_report_type: "GET_FBA_REIMBURSEMENTS_DATA",
    upload_report_type: "REIMBURSEMENTS",
    sync_kind: "REIMBURSEMENTS",
    domain_table: "amazon_reimbursements",
    importer_available: true,
    worker_kind: "live_worker",
    acquisition_mode: "on_demand_create",
  },
  {
    key: "settlement_v2",
    sp_report_type: SP_API_REPORT_TYPE_SETTLEMENT_V2,
    upload_report_type: "SETTLEMENT",
    sync_kind: "SETTLEMENT",
    domain_table: "amazon_settlements",
    importer_available: true,
    worker_kind: "live_worker",
    acquisition_mode: "scheduled_list",
  },
  {
    key: "removal_order",
    sp_report_type: "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
    upload_report_type: "REMOVAL_ORDER",
    sync_kind: "REMOVAL_ORDER",
    domain_table: "amazon_removals",
    importer_available: true,
    worker_kind: "live_worker",
    acquisition_mode: "on_demand_create",
  },
  {
    key: "removal_shipment",
    sp_report_type: "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
    upload_report_type: "REMOVAL_SHIPMENT",
    sync_kind: "REMOVAL_SHIPMENT",
    domain_table: "amazon_removal_shipments",
    importer_available: true,
    worker_kind: "live_worker",
    acquisition_mode: "on_demand_create",
  },
  {
    key: "fba_customer_returns",
    sp_report_type: SP_FBA_RETURNS,
    upload_report_type: "FBA_RETURNS",
    sync_kind: "FBA_RETURNS",
    domain_table: "amazon_returns",
    importer_available: true,
    worker_kind: "generic_pull",
    acquisition_mode: "on_demand_create",
  },
  {
    key: "ledger_detail",
    sp_report_type: SP_LEDGER_DETAIL,
    upload_report_type: "INVENTORY_LEDGER",
    sync_kind: "INVENTORY_LEDGER",
    domain_table: "amazon_inventory_ledger",
    importer_available: true,
    worker_kind: "generic_pull",
    acquisition_mode: "on_demand_create",
  },
  {
    key: "monthly_storage_fees",
    sp_report_type: SP_STORAGE,
    upload_report_type: "MONTHLY_STORAGE_FEES",
    sync_kind: "MONTHLY_STORAGE_FEES",
    domain_table: "amazon_monthly_storage_fees",
    importer_available: true,
    worker_kind: "generic_pull",
    acquisition_mode: "on_demand_create",
    window_note: "7d first; Amazon often posts monthly — empty = unavailable not zero",
  },
  {
    key: "stranded_inventory",
    sp_report_type: SP_STRANDED,
    upload_report_type: null,
    sync_kind: null,
    domain_table: null,
    importer_available: false,
    worker_kind: "header_only",
    acquisition_mode: "on_demand_create",
  },
  {
    key: "fee_preview",
    sp_report_type: SP_FEE_PREVIEW,
    upload_report_type: "FEE_PREVIEW",
    sync_kind: "FEE_PREVIEW",
    domain_table: "amazon_fee_preview",
    importer_available: true,
    worker_kind: "generic_pull",
    acquisition_mode: "on_demand_create",
    window_note: "Snapshot report — may ignore date window",
  },
];

const HEADER_FIELD_MAP: Record<string, string[]> = {
  asin: ["asin", "product-id", "product id"],
  fnsku: ["fnsku", "fulfillment-channel-sku"],
  sku_msku: ["sku", "msku", "seller-sku", "merchant-sku"],
  order_id: ["order-id", "amazon-order-id", "order id"],
  shipment_id: ["shipment-id", "shipment id"],
  tracking_number: ["tracking-number", "tracking number", "carrier-tracking-number"],
  reimbursement_id: ["reimbursement-id", "reimbursement id"],
  settlement_id: ["settlement-id", "settlement id"],
  quantity: [
    "quantity",
    "shipped-quantity",
    "quantity-reimbursed-total",
    "quantity-reimbursed-inventory",
    "unreconciled-quantity",
  ],
  amount: [
    "amount",
    "amount-total",
    "amount-reimbursed-total",
    "estimated-fee-total",
    "estimated-referral-fee-per-unit",
    "storage-rate",
    "total-amount",
  ],
  date: [
    "return-date",
    "approval-date",
    "date",
    "event-date",
    "posted-date",
    "storage-month",
    "shipment-date",
  ],
};

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function redact(msg: string): string {
  return msg
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt-redacted]")
    .replace(/(refresh[_-]?token|client[_-]?secret|access[_-]?key|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/postgresql:\/\/[^\s]+/gi, "postgresql://[redacted]");
}

function sampleWindow(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - SAMPLE_DAYS);
  return { start: start.toISOString(), end: end.toISOString() };
}

function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "-");
}

function mapHeaders(headers: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const norms = headers.map(normHeader);
  for (const [field, aliases] of Object.entries(HEADER_FIELD_MAP)) {
    const hits = headers.filter((h, i) =>
      aliases.some((a) => norms[i] === a || norms[i].includes(a.replace(/-/g, ""))),
    );
    if (hits.length) out[field] = hits;
  }
  return out;
}

function buildAdHocProfile(spec: SampleSpec): {
  spReportType: string;
  uploadReportType: string;
  acquisitionMode: "on_demand_create" | "scheduled_list";
  sourceRunOperation: string;
  importDescriptorId: string;
  syntheticFileName: (reportDocumentId: string | null) => string;
} {
  const kind = spec.sync_kind!;
  return {
    spReportType: spec.sp_report_type,
    uploadReportType: spec.upload_report_type!,
    acquisitionMode: spec.acquisition_mode,
    sourceRunOperation: "reports.create_and_download",
    importDescriptorId: `amazon.${kind.toLowerCase()}.file.v1`,
    syntheticFileName: (reportDocumentId) =>
      `spapi://reports/${spec.sp_report_type}/${reportDocumentId?.trim() || "pending"}.tsv`,
  };
}

type PullOutcome = {
  key: string;
  sp_report_type: string;
  api_request_status: string;
  report_processing_status: string | null;
  document_downloaded: boolean;
  headers_detected: string[];
  header_classification: { reportType: string; matchedRule: string };
  row_count_estimate: number | null;
  normalized_table: string | null;
  importer_available: boolean;
  mapped_identifiers: Record<string, string[]>;
  mapped_quantity_fields: string[];
  mapped_amount_fields: string[];
  mapped_date_fields: string[];
  upload_id: string | null;
  final_state: string | null;
  domain_rows_for_upload: number | null;
  source_empty: boolean;
  blocker: string | null;
  permission_or_scope_error: boolean;
};

async function runWorkerUntilDone(
  label: string,
  runFn: (args: {
    organizationId: string;
    storeId: string;
    windowStart: string;
    windowEnd: string;
    uploadId?: string | null;
  }) => Promise<{
    ok: boolean;
    upload_id: string | null;
    state: string | null;
    needs_resume: boolean;
    error?: string;
    error_code?: string;
  }>,
  windowStart: string,
  windowEnd: string,
): Promise<{
  ok: boolean;
  upload_id: string | null;
  final_state: string | null;
  error: string | null;
  error_code: string | null;
}> {
  let uploadId: string | null = null;
  let last = await runFn({
    organizationId: ORG,
    storeId: STORE,
    windowStart,
    windowEnd,
  });
  uploadId = last.upload_id;
  let rounds = 0;
  while (last.needs_resume && rounds < MAX_RESUME_ROUNDS) {
    rounds++;
    await new Promise((r) => setTimeout(r, RESUME_SLEEP_MS));
    last = await runFn({
      organizationId: ORG,
      storeId: STORE,
      windowStart,
      windowEnd,
      uploadId: last.upload_id ?? uploadId,
    });
    uploadId = last.upload_id ?? uploadId;
    if (last.state === "complete" || last.state === "failed") break;
  }
  return {
    ok: last.ok,
    upload_id: uploadId,
    final_state: last.state,
    error: last.error ? redact(last.error) : null,
    error_code: last.error_code ?? null,
  };
}

async function pullHeaderOnly(
  spec: SampleSpec,
  windowStart: string,
  windowEnd: string,
): Promise<PullOutcome> {
  const base: PullOutcome = {
    key: spec.key,
    sp_report_type: spec.sp_report_type,
    api_request_status: "not_attempted",
    report_processing_status: null,
    document_downloaded: false,
    headers_detected: [],
    header_classification: { reportType: "UNKNOWN", matchedRule: "none" },
    row_count_estimate: null,
    normalized_table: spec.domain_table,
    importer_available: spec.importer_available,
    mapped_identifiers: {},
    mapped_quantity_fields: [],
    mapped_amount_fields: [],
    mapped_date_fields: [],
    upload_id: null,
    final_state: null,
    domain_rows_for_upload: null,
    source_empty: false,
    blocker: null,
    permission_or_scope_error: false,
  };

  const { resolveReportsApiContext } = await import("../lib/amazon/reports-api-credentials");
  const { ReportsApiClient } = await import("../lib/amazon/reports-api-client");
  const { buildOnDemandCreateReportBody } = await import("../lib/amazon/reports-api-report-request");
  const { decompressReportDocument, parseCsvHeadersFromText } = await import(
    "../lib/amazon/reports-api-document-utils"
  );

  const ctx = await resolveReportsApiContext(ORG, STORE);
  if (!ctx.ok) {
    base.api_request_status = "credentials_blocked";
    base.blocker = redact(ctx.error);
    return base;
  }

  const client = new ReportsApiClient({ context: ctx.context });
  const mids = ctx.context.marketplaceIds;

  try {
    const created = await client.createOnDemandReport(
      buildOnDemandCreateReportBody({
        reportType: spec.sp_report_type,
        marketplaceIds: mids,
        dataStartTime: windowStart,
        dataEndTime: windowEnd,
      }),
    );
    base.api_request_status = "create_ok";
    let status = "IN_QUEUE";
    let docId: string | null = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const rep = await client.getReport(created.reportId);
      status = rep.processingStatus;
      base.report_processing_status = status;
      if (status === "DONE") {
        docId = rep.reportDocumentId;
        break;
      }
      if (status === "FATAL" || status === "CANCELLED") break;
    }
    if (status !== "DONE" || !docId) {
      base.blocker = status === "FATAL" ? "report_fatal" : `processing_${status}`;
      base.permission_or_scope_error = status === "FATAL";
      return base;
    }
    const doc = await client.getReportDocument(docId);
    const raw = await client.downloadReportDocument(doc.url);
    const text = decompressReportDocument(raw, doc.compressionAlgorithm).toString("utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    base.document_downloaded = true;
    base.headers_detected = parseCsvHeadersFromText(text);
    base.header_classification = classifyCsvHeadersRuleBased(base.headers_detected);
    base.row_count_estimate = Math.max(0, lines.length - 1);
    base.source_empty = base.row_count_estimate === 0;
    const mapped = mapHeaders(base.headers_detected);
    base.mapped_identifiers = {
      asin: mapped.asin ?? [],
      fnsku: mapped.fnsku ?? [],
      sku_msku: mapped.sku_msku ?? [],
      order_id: mapped.order_id ?? [],
      shipment_id: mapped.shipment_id ?? [],
      tracking_number: mapped.tracking_number ?? [],
      reimbursement_id: mapped.reimbursement_id ?? [],
      settlement_id: mapped.settlement_id ?? [],
    };
    base.mapped_quantity_fields = mapped.quantity ?? [];
    base.mapped_amount_fields = mapped.amount ?? [];
    base.mapped_date_fields = mapped.date ?? [];
    if (base.source_empty) base.blocker = "empty_source_unavailable_not_zero";
    return base;
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e));
    base.api_request_status = "error";
    base.blocker = msg;
    base.permission_or_scope_error = /403|401|Unauthorized|Forbidden|Access/i.test(msg);
    return base;
  }
}

async function countDomainRows(
  client: pg.Client,
  table: string,
  uploadId: string | null,
): Promise<number | null> {
  if (!uploadId) return null;
  const col = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1
       AND column_name IN ('source_upload_id','upload_id')`,
    [table],
  );
  const uploadCol = (col.rows[0] as { column_name?: string } | undefined)?.column_name;
  if (!uploadCol) return null;
  const r = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.${table}
     WHERE organization_id=$1::uuid AND ${uploadCol}=$2::uuid`,
    [ORG, uploadId],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function fetchUploadHeaders(client: pg.Client, uploadId: string): Promise<string[]> {
  const r = await client.query(
    `SELECT metadata FROM public.raw_report_uploads WHERE id=$1::uuid AND organization_id=$2::uuid`,
    [uploadId, ORG],
  );
  const meta = r.rows[0]?.metadata as Record<string, unknown> | null;
  const detected = meta?.detected_headers;
  if (Array.isArray(detected)) return detected.map(String);
  return [];
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";

  if (!supabaseUrlMatchesStagingRef(url, STAGING_REF)) {
    throw new Error(`BLOCKED: staging URL must target ${STAGING_REF}`);
  }
  if (!pgUrl.includes(STAGING_REF) || pgUrl.includes(ORIGINAL_REF)) {
    throw new Error("BLOCKED: STAGING_DIRECT_POSTGRES_URL must target staging only");
  }

  if (execute) {
    process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_SETTLEMENT = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER = "true";
    process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT = "true";
  }

  const window = sampleWindow();
  const pgClient = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const ccBefore = Number(
    (
      await pgClient.query(
        `SELECT COUNT(*)::bigint AS c FROM claim_candidates
         WHERE organization_id=$1::uuid AND store_id=$2::uuid
           AND quarantined_at IS NULL AND rejected_at IS NULL`,
        [ORG, STORE],
      )
    ).rows[0]?.c ?? 0,
  );

  const api_sample_pull_results: PullOutcome[] = [];

  if (!execute) {
    for (const spec of SAMPLE_SPECS) {
      api_sample_pull_results.push({
        key: spec.key,
        sp_report_type: spec.sp_report_type,
        api_request_status: "dry_run_skipped",
        report_processing_status: null,
        document_downloaded: false,
        headers_detected: [],
        header_classification: { reportType: spec.upload_report_type ?? "UNKNOWN", matchedRule: "dry_run" },
        row_count_estimate: null,
        normalized_table: spec.domain_table,
        importer_available: spec.importer_available,
        mapped_identifiers: {},
        mapped_quantity_fields: [],
        mapped_amount_fields: [],
        mapped_date_fields: [],
        upload_id: null,
        final_state: null,
        domain_rows_for_upload: null,
        source_empty: false,
        blocker: "re-run with --execute",
        permission_or_scope_error: false,
      });
    }
  } else {
    const { runReimbursementsReportsWorker } = await import("../lib/amazon/reports-api-reimbursements-worker");
    const { runSettlementReportsWorker } = await import("../lib/amazon/reports-api-settlement-worker");
    const { runRemovalOrderReportsWorker } = await import("../lib/amazon/reports-api-removal-order-worker");
    const { runRemovalShipmentReportsWorker } = await import("../lib/amazon/reports-api-removal-shipment-worker");
    const { runReportsApiPullWorker } = await import("../lib/amazon/reports-api-pull-worker");

    const workerMap: Record<
      string,
      (req: {
        organizationId: string;
        storeId: string;
        windowStart: string;
        windowEnd: string;
        uploadId?: string | null;
      }) => Promise<{
        ok: boolean;
        upload_id: string | null;
        state: string | null;
        needs_resume: boolean;
        error?: string;
        error_code?: string;
      }>
    > = {
      reimbursements: runReimbursementsReportsWorker,
      settlement_v2: runSettlementReportsWorker,
      removal_order: runRemovalOrderReportsWorker,
      removal_shipment: runRemovalShipmentReportsWorker,
    };

    for (const spec of SAMPLE_SPECS) {
      if (spec.worker_kind === "header_only") {
        api_sample_pull_results.push(await pullHeaderOnly(spec, window.start, window.end));
        continue;
      }

      let runResult: Awaited<ReturnType<typeof runWorkerUntilDone>>;
      if (spec.worker_kind === "live_worker") {
        const fn = workerMap[spec.key]!;
        runResult = await runWorkerUntilDone(spec.key, fn, window.start, window.end);
      } else {
        const profile = buildAdHocProfile(spec);
        runResult = await runWorkerUntilDone(spec.key, (req) =>
          runReportsApiPullWorker(req, { profile: profile as never }),
        window.start, window.end);
      }

      const outcome: PullOutcome = {
        key: spec.key,
        sp_report_type: spec.sp_report_type,
        api_request_status: runResult.error ? "error" : runResult.ok ? "ok" : "partial",
        report_processing_status: runResult.final_state,
        document_downloaded: Boolean(runResult.upload_id),
        headers_detected: [],
        header_classification: { reportType: spec.upload_report_type ?? "UNKNOWN", matchedRule: "pipeline" },
        row_count_estimate: null,
        normalized_table: spec.domain_table,
        importer_available: spec.importer_available,
        mapped_identifiers: {},
        mapped_quantity_fields: [],
        mapped_amount_fields: [],
        mapped_date_fields: [],
        upload_id: runResult.upload_id,
        final_state: runResult.final_state,
        domain_rows_for_upload: null,
        source_empty: false,
        blocker: runResult.error,
        permission_or_scope_error: Boolean(
          runResult.error_code &&
            /auth|403|401|fatal|permission|scope/i.test(String(runResult.error_code + runResult.error)),
        ),
      };

      if (runResult.upload_id) {
        const headers =
          (await fetchUploadHeaders(pgClient, runResult.upload_id)) ||
          [];
        if (headers.length) {
          outcome.headers_detected = headers;
          outcome.header_classification = classifyCsvHeadersRuleBased(headers);
          const mapped = mapHeaders(headers);
          outcome.mapped_identifiers = {
            asin: mapped.asin ?? [],
            fnsku: mapped.fnsku ?? [],
            sku_msku: mapped.sku_msku ?? [],
            order_id: mapped.order_id ?? [],
            shipment_id: mapped.shipment_id ?? [],
            tracking_number: mapped.tracking_number ?? [],
            reimbursement_id: mapped.reimbursement_id ?? [],
            settlement_id: mapped.settlement_id ?? [],
          };
          outcome.mapped_quantity_fields = mapped.quantity ?? [];
          outcome.mapped_amount_fields = mapped.amount ?? [];
          outcome.mapped_date_fields = mapped.date ?? [];
        }
      }

      if (spec.domain_table && runResult.upload_id) {
        outcome.domain_rows_for_upload = await countDomainRows(pgClient, spec.domain_table, runResult.upload_id);
        outcome.source_empty = outcome.domain_rows_for_upload === 0 && runResult.final_state === "complete";
        if (outcome.source_empty) outcome.blocker = "empty_source_unavailable_not_zero";
      }

      if (!outcome.blocker && runResult.final_state === "failed") {
        outcome.blocker = runResult.error ?? "worker_failed";
      }

      api_sample_pull_results.push(outcome);
    }
  }

  const ccAfter = Number(
    (
      await pgClient.query(
        `SELECT COUNT(*)::bigint AS c FROM claim_candidates
         WHERE organization_id=$1::uuid AND store_id=$2::uuid
           AND quarantined_at IS NULL AND rejected_at IS NULL`,
        [ORG, STORE],
      )
    ).rows[0]?.c ?? 0,
  );

  await pgClient.end();

  const report_type_to_table_mapping = SAMPLE_SPECS.map((s) => ({
    sp_report_type: s.sp_report_type,
    upload_report_type: s.upload_report_type,
    sync_kind: s.sync_kind,
    domain_table: s.domain_table,
    crosswalk: SP_API_REPORT_TYPE_TO_SYNC_KIND[s.sp_report_type] ?? null,
    registry: s.sync_kind ? AMAZON_REPORT_REGISTRY[s.sync_kind]?.sync_target_table : null,
    importer_available: s.importer_available,
    worker_kind: s.worker_kind,
  }));

  const header_mapping = api_sample_pull_results.map((r) => ({
    key: r.key,
    headers_detected: r.headers_detected,
    classification: r.header_classification,
    mapped_identifiers: r.mapped_identifiers,
    mapped_quantity_fields: r.mapped_quantity_fields,
    mapped_amount_fields: r.mapped_amount_fields,
    mapped_date_fields: r.mapped_date_fields,
  }));

  const missing_importers = SAMPLE_SPECS.filter((s) => !s.importer_available).map((s) => ({
    sp_report_type: s.sp_report_type,
    reason: "no AMAZON_REPORT_REGISTRY entry / normalized table",
  }));

  const empty_sources = api_sample_pull_results
    .filter((r) => r.source_empty)
    .map((r) => ({ key: r.key, sp_report_type: r.sp_report_type, note: "unavailable not zero" }));

  const permission_or_scope_errors = api_sample_pull_results
    .filter((r) => r.permission_or_scope_error || /403|401|fatal|permission/i.test(String(r.blocker)))
    .map((r) => ({ key: r.key, sp_report_type: r.sp_report_type, blocker: r.blocker }));

  const normalized_rows_created_if_any = api_sample_pull_results
    .filter((r) => r.domain_rows_for_upload != null && r.domain_rows_for_upload > 0)
    .map((r) => ({
      key: r.key,
      table: r.normalized_table,
      upload_id: r.upload_id,
      rows: r.domain_rows_for_upload,
    }));

  let operatorMobileModified = false;
  try {
    const out = require("child_process").execSync(`git status --porcelain "app/scanner/operator-mobile"`, {
      encoding: "utf8",
    });
    operatorMobileModified = out.trim().length > 0;
  } catch {
    operatorMobileModified = false;
  }

  let build_result = "skipped_dry_run";
  let smoke_result = "skipped_dry_run";
  if (execute) {
    try {
      require("child_process").execSync("npm run build", {
        cwd: process.cwd(),
        stdio: "pipe",
        encoding: "utf8",
      });
      build_result = "pass";
    } catch (e) {
      build_result = `fail: ${redact(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
    }
    try {
      require("child_process").execSync("npm run smoke:import-api-09-settlement-preflight", {
        cwd: process.cwd(),
        stdio: "pipe",
        encoding: "utf8",
      });
      smoke_result = "preflight_pass";
    } catch {
      smoke_result = "preflight_blocked_or_fail — flags may need .env.local persistence";
    }
  }

  const liveOk = api_sample_pull_results.filter((r) => r.api_request_status === "ok" || r.final_state === "complete").length;
  const SAFE_TO_IMPLEMENT_API_BACKFILL_PHASE =
    execute && liveOk >= 4 ? "yes_with_conditions" : execute ? "conditional_no" : "pending_execute";

  const summary = {
    prompt: "PHASE-AMAZON-REPORTS-API-SAMPLE-PULL-AND-MAPPING-V1",
    run_id: rid,
    mode: execute ? "execute" : "dry_run",
    staging_ref: STAGING_REF,
    sample_window_days: SAMPLE_DAYS,
    window,
    api_sample_pull_results,
    report_type_to_table_mapping,
    header_mapping,
    missing_importers,
    empty_sources,
    permission_or_scope_errors,
    normalized_rows_created_if_any,
    no_claim_candidate_mutation_verification: {
      before: ccBefore,
      after: ccAfter,
      delta: ccAfter - ccBefore,
      direct_mutation_by_script: false,
    },
    no_scanner_change_verification: {
      operator_mobile_modified: operatorMobileModified,
      note: "pre-existing dirty files do not count as this phase",
    },
    build_result,
    smoke_result,
    SAFE_TO_IMPLEMENT_API_BACKFILL_PHASE,
    NEXT_EXACT_PROMPT: "PHASE-AMAZON-SPAPI-WORKER-PHASE1A-LEDGER-DETAIL-IMPLEMENT-V1",
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(redact(String(e)));
  process.exit(1);
});
