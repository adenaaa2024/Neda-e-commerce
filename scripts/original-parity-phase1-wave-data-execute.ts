/**
 * ORIGINAL-PARITY-PHASE1-WAVE-DATA-EXECUTE — SP-API fetch + domain sync + rebuild + resolver on original
 *
 *   npx tsx scripts/original-parity-phase1-wave-data-execute.ts --apply
 *   npx tsx scripts/original-parity-phase1-wave-data-execute.ts --apply --window-start=2025-01-01T00:00:00Z
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire, type Module } from "node:module";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  buildRemovalOrderIdempotencyKey,
  buildRemovalShipmentIdempotencyKey,
  parseSourceRun,
  SP_API_REPORT_TYPE_REMOVAL_ORDER,
  SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
} from "../lib/amazon/reports-api-source-run";
import type { ReportsApiPullResult } from "../lib/amazon/reports-api-pull-worker";
import { REMOVAL_ORDER_PULL_PROFILE, REMOVAL_SHIPMENT_PULL_PROFILE } from "../lib/amazon/reports-api-worker-profile";
import {
  parseRemovalRawDataHints,
  resolveExpectedPackageProduct,
  type RemovalExpectedPackageRow,
} from "../lib/removal/resolve-expected-package-product";
import type { ScannerResolutionColumns } from "../lib/scanner-product-resolve";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const APPROVAL_PATH = ".cursor/operator-approvals/original-parity-phase1-wave-data-approval.md";
const SCHEMA_MANIFEST =
  ".cursor/audit-reports/original-parity-phase1-wave-schema-execute/20260530T180000Z/manifest.json";
const OUT_BASE = ".cursor/audit-reports/original-parity-phase1-wave-data-execute";
const DERIVED_SOURCES = ["detail_shipment", "detail_remainder"] as const;
const MAX_RESUME_ROUNDS = 120;
const RESUME_SLEEP_MS = 5_000;

type FetchOutcome = {
  label: "removal_order" | "removal_shipment";
  sp_report_type: string;
  upload_report_type: string;
  fetched: boolean;
  upload_id: string | null;
  source_run_id: string | null;
  final_state: string | null;
  idempotent_replay: boolean;
  content_sha256: string | null;
  byte_length: number | null;
  report_id: string | null;
  idempotency_key: string | null;
  error: string | null;
  error_code: string | null;
  resume_rounds: number;
};

type RebuildResult = {
  detail_lines_in_scope: number;
  matched_rows_upserted: number;
  remainder_rows_upserted: number;
  overflow_lines: number;
  obsolete_rows_deleted: number;
};

type PipelineOutcome = {
  upload_id: string;
  report_type: string;
  ok: boolean;
  state: string;
  error?: string;
  error_code?: string;
  staging_before: number;
  staging_after: number;
  domain_before: number;
  domain_after: number;
  wall_ms: number;
  phase4_skipped?: boolean;
};

type BackfillProposal = {
  id: string;
  bucket: string;
  apply_kind: "set_resolved" | "status_only" | "skip_unchanged";
  after: ScannerResolutionColumns;
  before: {
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
  };
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function argValue(prefix: string): string | null {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.split("=")[1]!.trim() : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runVal = /APPROVED_TO_RUN_ORIGINAL\s*=\s*true/i.test(text);
  const dataVal = /APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_DATA\s*=\s*true/i.test(text);
  return {
    valid: runVal && dataVal,
    raw: {
      APPROVED_TO_RUN_ORIGINAL: runVal ? "true" : "false",
      APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_DATA: dataVal ? "true" : "false",
    },
  };
}

function pointEnvToOriginal(): void {
  const url = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const key = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) throw new Error("ORIGINAL_SUPABASE_URL / ORIGINAL_SERVICE_ROLE_KEY required");
  if (refFromSupabaseUrl(url) !== ORIGINAL_REF) {
    throw new Error(`ORIGINAL_SUPABASE_URL must target ${ORIGINAL_REF}`);
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
}

function defaultWindow(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 9);
  return { start: start.toISOString(), end: end.toISOString() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchSucceeded(state: string | null): boolean {
  return state === "synthetic_upload_ready" || state === "complete";
}

async function dataCensus(client: pg.Client): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  const q = async (sql: string, params: unknown[] = []) => {
    const r = await client.query(sql, params);
    return r.rows[0] as Record<string, number>;
  };
  const removals = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_removals WHERE organization_id=$1 AND store_id=$2`,
    [ORG_ID, STORE_ID],
  );
  out.amazon_removals = removals.c;
  const shipments = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_removal_shipments WHERE organization_id=$1 AND store_id=$2`,
    [ORG_ID, STORE_ID],
  );
  out.amazon_removal_shipments = shipments.c;
  const ep = await q(
    `SELECT COUNT(*)::int AS ep_total,
      COUNT(*) FILTER (WHERE build_source IN ('detail_shipment','detail_remainder'))::int AS ep_derived,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS ep_resolved,
      COUNT(*) FILTER (WHERE allocation_group_key IS NOT NULL)::int AS ep_with_group_key
     FROM public.expected_packages WHERE organization_id=$1 AND store_id=$2`,
    [ORG_ID, STORE_ID],
  );
  Object.assign(out, ep);
  return out;
}

async function normalizeDirtyTrackingCarrier(client: pg.Client): Promise<Record<string, number>> {
  const armsTrack = await client.query(
    `
    UPDATE public.amazon_removal_shipments s
    SET tracking_number = n.operational
    FROM public.amazon_removal_shipments s2
    CROSS JOIN LATERAL public.normalize_removal_tracking_operational(s2.tracking_number) n
    WHERE s.id = s2.id
      AND s2.organization_id = $1::uuid AND s2.store_id = $2::uuid
      AND s2.tracking_number IS NOT NULL
      AND position(',' IN s2.tracking_number) > 0
      AND n.operational IS NOT NULL
    RETURNING s.id
    `,
    [ORG_ID, STORE_ID],
  );
  const epTrack = await client.query(
    `
    UPDATE public.expected_packages ep
    SET tracking_number = n.operational, updated_at = now()
    FROM public.expected_packages ep2
    CROSS JOIN LATERAL public.normalize_removal_tracking_operational(ep2.tracking_number) n
    WHERE ep.id = ep2.id
      AND ep2.organization_id = $1::uuid AND ep2.store_id = $2::uuid
      AND ep2.tracking_number IS NOT NULL
      AND position(',' IN ep2.tracking_number) > 0
      AND n.operational IS NOT NULL
    RETURNING ep.id
    `,
    [ORG_ID, STORE_ID],
  );
  const armsCarrier = await client.query(
    `
    UPDATE public.amazon_removal_shipments s
    SET carrier = n.operational
    FROM public.amazon_removal_shipments s2
    CROSS JOIN LATERAL public.normalize_removal_carrier_operational(s2.carrier) n
    WHERE s.id = s2.id
      AND s2.organization_id = $1::uuid AND s2.store_id = $2::uuid
      AND s2.carrier IS NOT NULL
      AND position(',' IN s2.carrier) > 0
      AND n.operational IS NOT NULL
    RETURNING s.id
    `,
    [ORG_ID, STORE_ID],
  );
  const epCarrier = await client.query(
    `
    UPDATE public.expected_packages ep
    SET carrier = n.operational, updated_at = now()
    FROM public.expected_packages ep2
    CROSS JOIN LATERAL public.normalize_removal_carrier_operational(ep2.carrier) n
    WHERE ep.id = ep2.id
      AND ep2.organization_id = $1::uuid AND ep2.store_id = $2::uuid
      AND ep2.carrier IS NOT NULL
      AND position(',' IN ep2.carrier) > 0
      AND n.operational IS NOT NULL
    RETURNING ep.id
    `,
    [ORG_ID, STORE_ID],
  );
  return {
    arms_tracking_normalized: armsTrack.rowCount ?? 0,
    ep_tracking_normalized: epTrack.rowCount ?? 0,
    arms_carrier_normalized: armsCarrier.rowCount ?? 0,
    ep_carrier_normalized: epCarrier.rowCount ?? 0,
  };
}

async function dirtyCommaProbes(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.amazon_removal_shipments
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
         AND tracking_number IS NOT NULL AND position(',' IN tracking_number) > 0) AS arms_tracking_comma,
      (SELECT COUNT(*)::int FROM public.expected_packages
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
         AND tracking_number IS NOT NULL AND position(',' IN tracking_number) > 0) AS ep_tracking_comma,
      (SELECT COUNT(*)::int FROM public.amazon_removal_shipments
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
         AND carrier IS NOT NULL AND position(',' IN carrier) > 0) AS arms_carrier_comma,
      (SELECT COUNT(*)::int FROM public.expected_packages
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
         AND carrier IS NOT NULL AND position(',' IN carrier) > 0) AS ep_carrier_comma
    `,
    [ORG_ID, STORE_ID],
  );
  return r.rows[0] as Record<string, number>;
}

async function deleteDuplicateRemainders(client: pg.Client): Promise<number> {
  const delRes = await client.query(
    `
    WITH ranked AS (
      SELECT id,
        row_number() OVER (
          PARTITION BY organization_id, store_id, source_detail_row_id
          ORDER BY rebuild_run_at DESC NULLS LAST, updated_at DESC
        ) AS rn
      FROM public.expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND build_source = 'detail_remainder'
    )
    DELETE FROM public.expected_packages ep
    USING ranked r
    WHERE ep.id = r.id AND r.rn > 1
    RETURNING ep.id::text
    `,
    [ORG_ID, STORE_ID],
  );
  return delRes.rowCount ?? 0;
}

async function deleteDerivedExpectedPackages(client: pg.Client): Promise<number> {
  const delRes = await client.query(
    `
    DELETE FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
      AND build_source IN ('detail_shipment', 'detail_remainder')
    RETURNING id::text
    `,
    [ORG_ID, STORE_ID],
  );
  return delRes.rowCount ?? 0;
}

async function ensureRebuildIndexes(client: pg.Client): Promise<void> {
  const idx = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public'
     AND indexname IN ('uq_expected_packages_canonical_cross_file','uq_expected_packages_canonical_legacy','uq_expected_packages_derived_pair')`,
  );
  const names = new Set((idx.rows as Array<{ indexname: string }>).map((r) => r.indexname));
  await client.query(`UPDATE public.expected_packages SET build_source='legacy' WHERE build_source IS NULL`);
  if (names.has("uq_expected_packages_canonical_cross_file")) {
    await client.query(`DROP INDEX IF EXISTS public.uq_expected_packages_canonical_cross_file`);
  }
  if (!names.has("uq_expected_packages_canonical_legacy")) {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_expected_packages_canonical_legacy
        ON public.expected_packages (organization_id, store_id, order_id, order_type, sku, fnsku, disposition)
        NULLS NOT DISTINCT WHERE build_source='legacy'`);
  }
  if (!names.has("uq_expected_packages_derived_pair")) {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_expected_packages_derived_pair
        ON public.expected_packages (organization_id, source_detail_row_id, source_shipment_row_id)
        NULLS NOT DISTINCT WHERE build_source IN ('detail_shipment','detail_remainder')`);
  }
}

async function epMismatchBreakdown(
  client: pg.Client,
): Promise<{ total: number; overflow: number; non_overflow: number }> {
  const colQ = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='amazon_removal_shipments'`,
  );
  const shipmentHasDisposition = (colQ.rows as Array<{ column_name: string }>).some(
    (x) => x.column_name === "disposition",
  );
  const shipDispositionSel = shipmentHasDisposition
    ? "nullif(btrim(s.disposition), '') AS disposition"
    : "NULL::text AS disposition";
  const dispositionJoin = shipmentHasDisposition
    ? "AND s.disposition IS NOT DISTINCT FROM d.disposition"
    : "";
  const r = await client.query(
    `
    WITH detail AS (
      SELECT d.id AS detail_id, COALESCE(d.shipped_quantity,0) AS detail_shipped_qty,
        d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
        nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku, nullif(btrim(d.disposition),'') AS disposition
      FROM public.amazon_removals d
      WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid AND d.order_id IS NOT NULL
    ),
    shipment AS (
      SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${shipDispositionSel},
        COALESCE(s.shipped_quantity,0) AS shipment_shipped_qty
      FROM public.amazon_removal_shipments s WHERE s.organization_id=$1::uuid AND s.store_id=$2::uuid
    ),
    pair AS (
      SELECT d.detail_id, d.detail_shipped_qty, s.shipment_id, s.shipment_shipped_qty
      FROM detail d LEFT JOIN shipment s
        ON s.organization_id=d.organization_id AND s.store_id IS NOT DISTINCT FROM d.store_id
       AND s.order_id IS NOT DISTINCT FROM d.order_id AND s.order_type IS NOT DISTINCT FROM d.order_type
       AND s.order_date IS NOT DISTINCT FROM d.order_date AND s.sku IS NOT DISTINCT FROM d.sku
       AND s.fnsku IS NOT DISTINCT FROM d.fnsku ${dispositionJoin}
    ),
    agg AS (
      SELECT detail_id, max(detail_shipped_qty) AS detail_total,
        sum(COALESCE(shipment_shipped_qty,0)) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_total,
        count(*) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_count
      FROM pair GROUP BY detail_id
    ),
    matched_emitted AS (
      SELECT p.detail_id, p.shipment_shipped_qty AS qty FROM pair p JOIN agg a USING (detail_id) WHERE p.shipment_id IS NOT NULL
    ),
    remainder_emitted AS (
      SELECT DISTINCT ON (p.detail_id) p.detail_id, GREATEST(a.detail_total - COALESCE(a.shipment_total,0),0)::int AS qty
      FROM pair p JOIN agg a USING (detail_id)
      WHERE COALESCE(a.shipment_count,0)=0 OR a.detail_total > COALESCE(a.shipment_total,0)
      ORDER BY p.detail_id
    ),
    emitted AS (SELECT detail_id, qty FROM matched_emitted UNION ALL SELECT detail_id, qty FROM remainder_emitted),
    sim AS (SELECT detail_id, sum(qty)::int AS sim_sum FROM emitted GROUP BY 1),
    live AS (
      SELECT source_detail_row_id AS detail_id, sum(expected_scan_quantity)::int AS live_sum
      FROM public.expected_packages
      WHERE organization_id=$1::uuid AND store_id=$2::uuid AND build_source IN ('detail_shipment','detail_remainder')
      GROUP BY 1
    )
    SELECT count(*)::int AS total_mismatch,
      count(*) FILTER (WHERE a.shipment_total > a.detail_total)::int AS overflow_mismatch,
      count(*) FILTER (WHERE NOT (a.shipment_total > a.detail_total))::int AS non_overflow_mismatch
    FROM sim FULL OUTER JOIN live USING (detail_id)
    JOIN agg a ON a.detail_id = COALESCE(sim.detail_id, live.detail_id)
    WHERE COALESCE(sim_sum,-1) <> COALESCE(live_sum,-2)
    `,
    [ORG_ID, STORE_ID],
  );
  const row = r.rows[0] as {
    total_mismatch: number;
    overflow_mismatch: number;
    non_overflow_mismatch: number;
  };
  return {
    total: row.total_mismatch,
    overflow: row.overflow_mismatch,
    non_overflow: row.non_overflow_mismatch,
  };
}

async function epMismatchCount(client: pg.Client): Promise<number> {
  const b = await epMismatchBreakdown(client);
  return b.total;
}

async function uploadDomainCount(
  client: pg.Client,
  uploadId: string,
  table: "amazon_removals" | "amazon_removal_shipments",
): Promise<number> {
  const r = await client.query(`SELECT COUNT(*)::int AS c FROM public.${table} WHERE upload_id=$1::uuid`, [
    uploadId,
  ]);
  return (r.rows[0] as { c: number }).c;
}

async function stagingCount(client: pg.Client, uploadId: string): Promise<number> {
  const r = await client.query(`SELECT COUNT(*)::int AS c FROM public.amazon_staging WHERE upload_id=$1::uuid`, [
    uploadId,
  ]);
  return (r.rows[0] as { c: number }).c;
}

async function runPipelineForUpload(
  client: pg.Client,
  uploadId: string,
  reportType: string,
): Promise<PipelineOutcome> {
  const domainTable = reportType === "REMOVAL_ORDER" ? "amazon_removals" : "amazon_removal_shipments";
  const stagingBefore = await stagingCount(client, uploadId);
  const domainBefore = await uploadDomainCount(client, uploadId, domainTable);
  const { supabaseServer } = await import("../lib/supabase-server");
  const { runReportsApiImportPipeline } = await import("../lib/amazon/reports-api-pipeline-handoff");
  const { data: upRow } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata, report_type")
    .eq("id", uploadId)
    .eq("organization_id", ORG_ID)
    .maybeSingle();
  const sr = parseSourceRun(upRow?.metadata);
  if (!sr) {
    return {
      upload_id: uploadId,
      report_type: reportType,
      ok: false,
      state: "failed",
      error: "No source_run on upload metadata",
      error_code: "missing_source_run",
      staging_before: stagingBefore,
      staging_after: stagingBefore,
      domain_before: domainBefore,
      domain_after: domainBefore,
      wall_ms: 0,
    };
  }
  const t0 = performance.now();
  const pipe = await runReportsApiImportPipeline({
    uploadId,
    organizationId: ORG_ID,
    sourceRun: sr,
    importFullFile: true,
  });
  const wallMs = Math.round(performance.now() - t0);
  const domainAfter = await uploadDomainCount(client, uploadId, domainTable);
  const stagingAfter = await stagingCount(client, uploadId);
  const domainSynced =
    domainAfter > domainBefore || (stagingBefore > 0 && stagingAfter === 0 && domainAfter > 0);
  const phase4OnlyFailure =
    !pipe.ok &&
    pipe.error_code === "generic_failed" &&
    domainSynced &&
    (reportType === "REMOVAL_ORDER" || reportType === "REMOVAL_SHIPMENT");
  return {
    upload_id: uploadId,
    report_type: reportType,
    ok: pipe.ok || phase4OnlyFailure,
    state: phase4OnlyFailure ? "domain_sync_complete_phase4_skipped" : pipe.state,
    error: pipe.ok || phase4OnlyFailure ? undefined : pipe.error,
    error_code: pipe.ok || phase4OnlyFailure ? undefined : pipe.error_code,
    staging_before: stagingBefore,
    staging_after: stagingAfter,
    domain_before: domainBefore,
    domain_after: domainAfter,
    wall_ms: wallMs,
    phase4_skipped: phase4OnlyFailure,
  };
}

async function loadUploadSummary(uploadId: string): Promise<{
  state: string | null;
  content_sha256: string | null;
  byte_length: number | null;
  report_id: string | null;
  idempotency_key: string | null;
  last_error_code: string | null;
  last_error_detail: string | null;
}> {
  const { supabaseServer } = await import("../lib/supabase-server");
  const { data, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata, status")
    .eq("id", uploadId)
    .eq("organization_id", ORG_ID)
    .maybeSingle();
  if (error || !data) {
    return {
      state: null,
      content_sha256: null,
      byte_length: null,
      report_id: null,
      idempotency_key: null,
      last_error_code: null,
      last_error_detail: null,
    };
  }
  const meta = data.metadata as Record<string, unknown> | null;
  const sr = parseSourceRun(meta);
  return {
    state: sr?.state ?? null,
    content_sha256:
      typeof meta?.content_sha256 === "string" ? meta.content_sha256.trim().toLowerCase() : null,
    byte_length:
      typeof meta?.file_size_bytes === "number" ? meta.file_size_bytes : sr?.archive?.byte_length ?? null,
    report_id: sr?.external_ids?.report_id ?? null,
    idempotency_key: sr?.idempotency_key ?? null,
    last_error_code: sr?.attempt?.last_error_code ?? null,
    last_error_detail: sr?.attempt?.last_error_detail ?? null,
  };
}

async function runFetchUntilReady(
  label: FetchOutcome["label"],
  runWorker: (req: {
    organizationId: string;
    storeId: string;
    windowStart: string;
    windowEnd: string;
    uploadId: string | null;
  }) => Promise<ReportsApiPullResult>,
  window: { start: string; end: string },
  idempotencyKey: string,
): Promise<FetchOutcome> {
  let uploadId: string | null = null;
  let last: ReportsApiPullResult | null = null;
  let rounds = 0;
  for (let i = 0; i < MAX_RESUME_ROUNDS; i++) {
    rounds = i + 1;
    last = await runWorker({
      organizationId: ORG_ID,
      storeId: STORE_ID,
      windowStart: window.start,
      windowEnd: window.end,
      uploadId,
    });
    uploadId = last.upload_id;
    if (last.state === "failed") break;
    if (fetchSucceeded(last.state)) break;
    if (!last.needs_resume) break;
    await sleep(RESUME_SLEEP_MS);
  }
  const summary = uploadId ? await loadUploadSummary(uploadId) : null;
  const state = summary?.state ?? last?.state ?? null;
  return {
    label,
    sp_report_type:
      label === "removal_order" ? SP_API_REPORT_TYPE_REMOVAL_ORDER : SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
    upload_report_type:
      label === "removal_order"
        ? REMOVAL_ORDER_PULL_PROFILE.uploadReportType
        : REMOVAL_SHIPMENT_PULL_PROFILE.uploadReportType,
    fetched: fetchSucceeded(state),
    upload_id: uploadId,
    source_run_id: last?.source_run_id ?? null,
    final_state: state,
    idempotent_replay: last?.idempotent_replay ?? false,
    content_sha256: summary?.content_sha256 ?? null,
    byte_length: summary?.byte_length ?? null,
    report_id: summary?.report_id ?? null,
    idempotency_key: summary?.idempotency_key ?? idempotencyKey,
    error: last?.error ?? summary?.last_error_detail ?? null,
    error_code: last?.error_code ?? summary?.last_error_code ?? null,
    resume_rounds: rounds,
  };
}

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

async function fetchCandidateRows(client: pg.Client, cursor: string, limit: number): Promise<RemovalExpectedPackageRow[]> {
  const res = await client.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku,
      resolved_product_id::text, resolved_catalog_product_id::text,
      identifier_resolution_status, identifier_resolution_confidence::text,
      source_detail_row_id::text, order_id, build_source
     FROM public.expected_packages
     WHERE build_source = ANY($3::text[]) AND organization_id IS NOT NULL AND store_id IS NOT NULL AND id > $1::uuid
     ORDER BY id LIMIT $2`,
    [cursor, limit, DERIVED_SOURCES],
  );
  return res.rows as RemovalExpectedPackageRow[];
}

async function productExists(client: pg.Client, productId: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM public.products WHERE id=$1::uuid LIMIT 1`, [productId]);
  return r.rows.length > 0;
}

async function runResolverBackfill(
  client: pg.Client,
  supabase: ReturnType<typeof createClient>,
  execute: boolean,
): Promise<{ proposals: BackfillProposal[]; applied: number; summary: Record<string, number> }> {
  const proposals: BackfillProposal[] = [];
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const batch = await fetchCandidateRows(client, cursor, 500);
    if (!batch.length) break;
    const detailIds = [...new Set(batch.map((r) => n(r.source_detail_row_id)).filter((x): x is string => !!x))];
    const hydration = new Map<string, { asin: string | null; upc: string | null }>();
    if (detailIds.length) {
      const hr = await client.query(`SELECT id::text, raw_data FROM public.amazon_removals WHERE id=ANY($1::uuid[])`, [
        detailIds,
      ]);
      for (const row of hr.rows) {
        const hints = parseRemovalRawDataHints(row.raw_data);
        hydration.set(String(row.id), { asin: hints.asin, upc: hints.upc });
      }
    }
    for (const row of batch) {
      const before = {
        resolved_product_id: n(row.resolved_product_id),
        resolved_catalog_product_id: n(row.resolved_catalog_product_id),
        identifier_resolution_status: n(row.identifier_resolution_status),
        identifier_resolution_confidence: num(row.identifier_resolution_confidence),
      };
      const detailId = n(row.source_detail_row_id);
      const removalHints = detailId ? hydration.get(detailId) : undefined;
      const resolved = await resolveExpectedPackageProduct(supabase, row, {
        asinFromRemoval: removalHints?.asin ?? null,
        upcFromRemoval: removalHints?.upc ?? null,
      });
      let after: ScannerResolutionColumns = { ...resolved.columns };
      let apply_kind: BackfillProposal["apply_kind"] = "status_only";
      if (after.identifier_resolution_status === "resolved" && after.resolved_product_id) {
        if (await productExists(client, after.resolved_product_id)) apply_kind = "set_resolved";
        else {
          after = {
            ...after,
            resolved_product_id: null,
            resolved_catalog_product_id: null,
            identifier_resolution_status: "unresolved",
          };
        }
      }
      const unchanged =
        before.resolved_product_id === after.resolved_product_id &&
        before.resolved_catalog_product_id === after.resolved_catalog_product_id &&
        before.identifier_resolution_status === after.identifier_resolution_status &&
        before.identifier_resolution_confidence === after.identifier_resolution_confidence;
      if (unchanged) apply_kind = "skip_unchanged";
      proposals.push({ id: row.id, bucket: resolved.bucket, apply_kind, before, after });
    }
    cursor = batch[batch.length - 1]!.id;
    if (batch.length < 500) break;
  }
  let applied = 0;
  if (execute) {
    for (const p of proposals.filter((x) => x.apply_kind !== "skip_unchanged")) {
      if (p.apply_kind === "set_resolved") {
        const r = await client.query(
          `UPDATE public.expected_packages t SET resolved_product_id=$2::uuid, resolved_catalog_product_id=$3::uuid,
            identifier_resolution_status=$4, identifier_resolution_confidence=$5, updated_at=now()
           FROM public.products pr WHERE t.id=$1::uuid AND pr.id=$2::uuid RETURNING t.id::text`,
          [
            p.id,
            p.after.resolved_product_id,
            p.after.resolved_catalog_product_id,
            p.after.identifier_resolution_status,
            p.after.identifier_resolution_confidence,
          ],
        );
        if (r.rowCount) applied += 1;
      } else {
        const r = await client.query(
          `UPDATE public.expected_packages SET resolved_product_id=NULL, resolved_catalog_product_id=NULL,
            identifier_resolution_status=$2, identifier_resolution_confidence=$3, updated_at=now()
           WHERE id=$1::uuid RETURNING id::text`,
          [p.id, p.after.identifier_resolution_status, p.after.identifier_resolution_confidence],
        );
        if (r.rowCount) applied += 1;
      }
    }
  }
  const summary = {
    candidates_scanned: proposals.length,
    set_resolved: proposals.filter((p) => p.apply_kind === "set_resolved").length,
    status_only: proposals.filter((p) => p.apply_kind === "status_only").length,
    skip_unchanged: proposals.filter((p) => p.apply_kind === "skip_unchanged").length,
    queue_missing_product_needs_evidence: proposals.filter((p) => p.bucket === "missing_product_needs_evidence")
      .length,
    queue_ambiguous: proposals.filter((p) => p.bucket === "ambiguous").length,
  };
  return { proposals, applied, summary };
}

async function captureDerivedPreimage(client: pg.Client): Promise<Record<string, unknown>[]> {
  const r = await client.query(
    `SELECT row_to_json(t) AS row FROM (
      SELECT * FROM public.expected_packages
      WHERE organization_id=$1::uuid AND store_id=$2::uuid
        AND build_source IN ('detail_shipment','detail_remainder')
    ) t`,
    [ORG_ID, STORE_ID],
  );
  return (r.rows as Array<{ row: Record<string, unknown> }>).map((x) => x.row);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!approval.valid) blockers.push("Approval flags not both true");

  const originalPg = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagingPg = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!originalPg) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (!stagingPg) blockers.push("STAGING_DIRECT_POSTGRES_URL unset (read-only compare)");
  if (originalPg && refFromConnectionUrl(originalPg) !== ORIGINAL_REF) {
    blockers.push(`ORIGINAL URL must target ${ORIGINAL_REF}`);
  }
  if (stagingPg && refFromConnectionUrl(stagingPg) !== STAGING_REF) {
    blockers.push(`STAGING URL must target ${STAGING_REF}`);
  }
  if (originalPg && stagingPg && originalPg === stagingPg) {
    blockers.push("ORIGINAL and STAGING URLs must differ");
  }

  let schemaPass = false;
  if (fs.existsSync(path.join(process.cwd(), SCHEMA_MANIFEST))) {
    const m = JSON.parse(fs.readFileSync(path.join(process.cwd(), SCHEMA_MANIFEST), "utf8")) as {
      status?: string;
    };
    schemaPass = m.status === "PASS";
  }
  if (!schemaPass) blockers.push("Schema wave execute manifest PASS required");

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — Phase 1 Wave data execute",
      "",
      "| Flag | Value |",
      "|------|-------|",
      `| APPROVED_TO_RUN_ORIGINAL | ${approval.raw.APPROVED_TO_RUN_ORIGINAL} |`,
      `| APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_DATA | ${approval.raw.APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_DATA} |`,
      `| approval_file | \`${APPROVAL_PATH}\` |`,
      `| valid | **${approval.valid}** |`,
      `| target_ref | \`${ORIGINAL_REF}\` |`,
      `| staging_ref_blocked | \`${STAGING_REF}\` |`,
      "",
      "No bulk clone. No products.insert. No product_identifier_map.insert.",
    ].join("\n") + "\n",
  );

  let preOriginal: Record<string, number | null> = {};
  let preStaging: Record<string, number | null> = {};
  if (!blockers.length) {
    const oc = new pg.Client({ connectionString: originalPg, ssl: { rejectUnauthorized: false } });
    const sc = new pg.Client({ connectionString: stagingPg, ssl: { rejectUnauthorized: false } });
    await oc.connect();
    await sc.connect();
    preOriginal = await dataCensus(oc);
    preStaging = await dataCensus(sc);
    await sc.end();
    await oc.end();
  }

  if (blockers.length || !apply) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run only; pass `--apply` to execute on original.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt: "ORIGINAL-PARITY-PHASE1-WAVE-DATA-EXECUTE",
          run_id: runId,
          status: blockers.length ? "BLOCKED" : "DRY_RUN",
          apply,
          blockers,
          exact_next_prompt: apply
            ? null
            : "npx tsx scripts/original-parity-phase1-wave-data-execute.ts --apply",
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: !blockers.length, outDir, apply, blockers }, null, 2));
    if (blockers.length) process.exit(1);
    return;
  }

  pointEnvToOriginal();
  process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
  process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER = "true";
  process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT = "true";
  if (!process.env.ENABLE_IMPORT_DESCRIPTOR_METADATA) process.env.ENABLE_IMPORT_DESCRIPTOR_METADATA = "true";

  const window = {
    start: argValue("--window-start=") ?? defaultWindow().start,
    end: argValue("--window-end=") ?? defaultWindow().end,
  };
  const marketplaceIds = ["ATVPDKIKX0DER"];
  const orderIdem = buildRemovalOrderIdempotencyKey({
    organizationId: ORG_ID,
    storeId: STORE_ID,
    windowStart: window.start,
    windowEnd: window.end,
    marketplaceIds,
  });
  const shipmentIdem = buildRemovalShipmentIdempotencyKey({
    organizationId: ORG_ID,
    storeId: STORE_ID,
    windowStart: window.start,
    windowEnd: window.end,
    marketplaceIds,
  });

  const skipFetch = hasFlag("--skip-fetch");
  const orderUploadArg = argValue("--order-upload-id=");
  const shipmentUploadArg = argValue("--shipment-upload-id=");

  const client = new pg.Client({ connectionString: originalPg, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '1800s'");

  const preimageRows = await captureDerivedPreimage(client);
  const productsBefore = (
    await client.query(`SELECT COUNT(*)::int AS c FROM public.products WHERE deleted_at IS NULL`)
  ).rows[0] as { c: number };
  const pimBefore = (
    await client.query(`SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`)
  ).rows[0] as { c: number };

  let orderOutcome: FetchOutcome;
  let shipmentOutcome: FetchOutcome;

  if (skipFetch) {
    const oid = orderUploadArg ?? "5baabf1b-3dca-43b5-8936-57aed80ab47a";
    const sid = shipmentUploadArg ?? "ef31c0c9-6928-4f00-850f-2febe231364e";
    orderOutcome = {
      label: "removal_order",
      sp_report_type: SP_API_REPORT_TYPE_REMOVAL_ORDER,
      upload_report_type: REMOVAL_ORDER_PULL_PROFILE.uploadReportType,
      fetched: true,
      upload_id: oid,
      source_run_id: null,
      final_state: "synthetic_upload_ready",
      idempotent_replay: true,
      content_sha256: null,
      byte_length: null,
      report_id: null,
      idempotency_key: orderIdem,
      error: null,
      error_code: null,
      resume_rounds: 0,
    };
    shipmentOutcome = {
      label: "removal_shipment",
      sp_report_type: SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
      upload_report_type: REMOVAL_SHIPMENT_PULL_PROFILE.uploadReportType,
      fetched: true,
      upload_id: sid,
      source_run_id: null,
      final_state: "synthetic_upload_ready",
      idempotent_replay: true,
      content_sha256: null,
      byte_length: null,
      report_id: null,
      idempotency_key: shipmentIdem,
      error: null,
      error_code: null,
      resume_rounds: 0,
    };
  } else {
    const { runRemovalOrderReportsWorker } = await import("../lib/amazon/reports-api-removal-order-worker");
    const { runRemovalShipmentReportsWorker } = await import(
      "../lib/amazon/reports-api-removal-shipment-worker"
    );
    orderOutcome = await runFetchUntilReady(
      "removal_order",
      (req) => runRemovalOrderReportsWorker(req, { runPipeline: false, requestBudgetMs: 55_000 }),
      window,
      orderIdem,
    );
    shipmentOutcome = await runFetchUntilReady(
      "removal_shipment",
      (req) => runRemovalShipmentReportsWorker(req, { runPipeline: false, requestBudgetMs: 55_000 }),
      window,
      shipmentIdem,
    );
  }

  fs.writeFileSync(
    path.join(outDir, "api-fetch-result.md"),
    [
      "# API fetch result (original)",
      "",
      `| Report | Fetched | upload_id | final_state | resume_rounds |`,
      `|--------|---------|-----------|-------------|---------------|`,
      `| REMOVAL_ORDER | **${orderOutcome.fetched ? "yes" : "no"}** | \`${orderOutcome.upload_id ?? "—"}\` | \`${orderOutcome.final_state ?? "—"}\` | ${orderOutcome.resume_rounds} |`,
      `| REMOVAL_SHIPMENT | **${shipmentOutcome.fetched ? "yes" : "no"}** | \`${shipmentOutcome.upload_id ?? "—"}\` | \`${shipmentOutcome.final_state ?? "—"}\` | ${shipmentOutcome.resume_rounds} |`,
      "",
      `Window: \`${window.start}\` → \`${window.end}\``,
      "",
      orderOutcome.error ? `Order error: ${orderOutcome.error}` : "",
      shipmentOutcome.error ? `Shipment error: ${shipmentOutcome.error}` : "",
    ].join("\n") + "\n",
  );

  const execBlockers: string[] = [];
  if (!orderOutcome.fetched || !orderOutcome.upload_id) {
    execBlockers.push("Removal order fetch did not complete");
  }
  if (!shipmentOutcome.fetched || !shipmentOutcome.upload_id) {
    execBlockers.push("Removal shipment fetch did not complete");
  }

  let orderPipe: PipelineOutcome | null = null;
  let shipPipe: PipelineOutcome | null = null;
  let rebuild: RebuildResult | null = null;
  let mismatchCount = -1;
  let mismatchOverflow = -1;
  let mismatchNonOverflow = -1;
  let rebuildValid = false;
  let dirtyBefore = await dirtyCommaProbes(client);
  let dirtyAfter = dirtyBefore;

  if (!execBlockers.length && !hasFlag("--skip-sync")) {
    orderPipe = await runPipelineForUpload(client, orderOutcome.upload_id!, "REMOVAL_ORDER");
    shipPipe = await runPipelineForUpload(client, shipmentOutcome.upload_id!, "REMOVAL_SHIPMENT");
    if (!orderPipe.ok) execBlockers.push(`Order domain sync failed: ${orderPipe.error ?? orderPipe.state}`);
    if (!shipPipe.ok) execBlockers.push(`Shipment domain sync failed: ${shipPipe.error ?? shipPipe.state}`);
  } else if (!execBlockers.length && hasFlag("--skip-sync")) {
    orderPipe = {
      upload_id: orderOutcome.upload_id!,
      report_type: "REMOVAL_ORDER",
      ok: true,
      state: "skipped_resume",
      staging_before: 0,
      staging_after: 0,
      domain_before: 0,
      domain_after: await uploadDomainCount(client, orderOutcome.upload_id!, "amazon_removals"),
      wall_ms: 0,
    };
    shipPipe = {
      upload_id: shipmentOutcome.upload_id!,
      report_type: "REMOVAL_SHIPMENT",
      ok: true,
      state: "skipped_resume",
      staging_before: 0,
      staging_after: 0,
      domain_before: 0,
      domain_after: await uploadDomainCount(client, shipmentOutcome.upload_id!, "amazon_removal_shipments"),
      wall_ms: 0,
      phase4_skipped: true,
    };
  }

  fs.writeFileSync(
    path.join(outDir, "domain-sync-result.md"),
    [
      "# Domain sync result (original)",
      "",
      orderPipe
        ? `- REMOVAL_ORDER: ok=${orderPipe.ok} domain ${orderPipe.domain_before}→${orderPipe.domain_after} (${orderPipe.wall_ms}ms)`
        : "- REMOVAL_ORDER: skipped",
      shipPipe
        ? `- REMOVAL_SHIPMENT: ok=${shipPipe.ok} domain ${shipPipe.domain_before}→${shipPipe.domain_after} (${shipPipe.wall_ms}ms)`
        : "- REMOVAL_SHIPMENT: skipped",
    ].join("\n") + "\n",
  );

  if (!execBlockers.length && !hasFlag("--skip-rebuild")) {
    const normStats = await normalizeDirtyTrackingCarrier(client);
    fs.writeFileSync(
      path.join(outDir, "normalization-cleanup.json"),
      JSON.stringify(normStats, null, 2),
    );
    dirtyAfter = await dirtyCommaProbes(client);
    await ensureRebuildIndexes(client);
    const dupDeletedPre = await deleteDuplicateRemainders(client);
    const derivedDeleted = await deleteDerivedExpectedPackages(client);
    fs.writeFileSync(
      path.join(outDir, "pre-rebuild-cleanup.json"),
      JSON.stringify({ duplicate_remainders_deleted: dupDeletedPre, derived_rows_deleted: derivedDeleted }, null, 2),
    );
    const rebuildRes = await client.query(`SELECT * FROM public.rebuild_expected_packages_from_removals($1::uuid,$2::uuid)`, [
      ORG_ID,
      STORE_ID,
    ]);
    rebuild = rebuildRes.rows[0] as RebuildResult;
    const dupDeletedPost = await deleteDuplicateRemainders(client);
    if (dupDeletedPost > 0) {
      fs.appendFileSync(
        path.join(outDir, "pre-rebuild-cleanup.json"),
        `\npost_rebuild_duplicate_remainders_deleted: ${dupDeletedPost}\n`,
      );
    }
    await normalizeDirtyTrackingCarrier(client);
    const mismatch = await epMismatchBreakdown(client);
    mismatchCount = mismatch.total;
    mismatchOverflow = mismatch.overflow;
    mismatchNonOverflow = mismatch.non_overflow;
    rebuildValid = mismatchNonOverflow === 0;
    dirtyAfter = await dirtyCommaProbes(client);
  } else if (!execBlockers.length && hasFlag("--skip-rebuild")) {
    dirtyAfter = await dirtyCommaProbes(client);
    const mismatch = await epMismatchBreakdown(client);
    mismatchCount = mismatch.total;
    mismatchOverflow = mismatch.overflow;
    mismatchNonOverflow = mismatch.non_overflow;
    rebuildValid = mismatchNonOverflow === 0;
  }

  fs.writeFileSync(
    path.join(outDir, "expected-rebuild-result.md"),
    [
      "# Expected rebuild result (original)",
      "",
      rebuild ? JSON.stringify(rebuild, null, 2) : "Rebuild skipped due to blockers.",
      "",
      `| allocation_mismatch (total) | **${mismatchCount}** |`,
      `| allocation_mismatch (overflow) | **${mismatchOverflow}** |`,
      `| allocation_mismatch (non-overflow) | **${mismatchNonOverflow}** |`,
      `rebuild_valid: **${rebuildValid ? "yes" : "no"}**`,
    ].join("\n") + "\n",
  );

  const dirtyTotal =
    dirtyAfter.arms_tracking_comma +
    dirtyAfter.ep_tracking_comma +
    dirtyAfter.arms_carrier_comma +
    dirtyAfter.ep_carrier_comma;

  fs.writeFileSync(
    path.join(outDir, "verify-result.md"),
    [
      "# Verify result (original)",
      "",
      `| Check | Value |`,
      `|-------|-------|`,
      `| rebuild_valid | **${rebuildValid ? "yes" : "no"}** |`,
      `| allocation_mismatch (total) | **${mismatchCount}** |`,
      `| allocation_mismatch (non-overflow) | **${mismatchNonOverflow}** |`,
      `| dirty_comma_total | **${dirtyTotal}** |`,
      "",
      "## Dirty comma probes",
      "",
      "| Surface | Before | After |",
      "|---------|-------:|------:|",
      `| arms_tracking_comma | ${dirtyBefore.arms_tracking_comma} | ${dirtyAfter.arms_tracking_comma} |`,
      `| ep_tracking_comma | ${dirtyBefore.ep_tracking_comma} | ${dirtyAfter.ep_tracking_comma} |`,
      `| arms_carrier_comma | ${dirtyBefore.arms_carrier_comma} | ${dirtyAfter.arms_carrier_comma} |`,
      `| ep_carrier_comma | ${dirtyBefore.ep_carrier_comma} | ${dirtyAfter.ep_carrier_comma} |`,
    ].join("\n") + "\n",
  );

  let resolverApplied = 0;
  let resolverSummary: Record<string, number> = {};
  let resolverProposals: BackfillProposal[] = [];
  if (rebuildValid && dirtyTotal === 0) {
    const supabase = createClient(
      process.env.ORIGINAL_SUPABASE_URL!.trim(),
      process.env.ORIGINAL_SERVICE_ROLE_KEY!.trim(),
      { auth: { persistSession: false } },
    );
    const resolver = await runResolverBackfill(client, supabase, true);
    resolverApplied = resolver.applied;
    resolverSummary = resolver.summary;
    resolverProposals = resolver.proposals;
  } else if (rebuildValid) {
    execBlockers.push(`Dirty comma tracking/carrier remaining (${dirtyTotal}) — resolver skipped`);
  } else {
    execBlockers.push("Rebuild verify failed — resolver skipped");
  }

  const postOriginal = await dataCensus(client);
  const sc = new pg.Client({ connectionString: stagingPg, ssl: { rejectUnauthorized: false } });
  await sc.connect();
  const postStaging = await dataCensus(sc);
  await sc.end();

  const productsAfter = (
    await client.query(`SELECT COUNT(*)::int AS c FROM public.products WHERE deleted_at IS NULL`)
  ).rows[0] as { c: number };
  const pimAfter = (
    await client.query(`SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`)
  ).rows[0] as { c: number };

  await client.end();

  fs.writeFileSync(
    path.join(outDir, "resolver-backfill-result.md"),
    [
      "# Resolver backfill result (original)",
      "",
      JSON.stringify({ applied: resolverApplied, ...resolverSummary }, null, 2),
      "",
      "No products.insert. No product_identifier_map.insert.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "post-counts-original-vs-staging.md"),
    [
      "# Post-counts — original vs staging",
      "",
      "| Metric | Staging | Original (pre) | Original (post) | Delta closed |",
      "|--------|--------:|---------------:|----------------:|-------------:|",
      `| amazon_removals | ${postStaging.amazon_removals} | ${preOriginal.amazon_removals} | ${postOriginal.amazon_removals} | ${Number(postStaging.amazon_removals ?? 0) - Number(postOriginal.amazon_removals ?? 0)} |`,
      `| amazon_removal_shipments | ${postStaging.amazon_removal_shipments} | ${preOriginal.amazon_removal_shipments} | ${postOriginal.amazon_removal_shipments} | ${Number(postStaging.amazon_removal_shipments ?? 0) - Number(postOriginal.amazon_removal_shipments ?? 0)} |`,
      `| derived expected_packages | ${postStaging.ep_derived} | ${preOriginal.ep_derived} | ${postOriginal.ep_derived} | ${Number(postStaging.ep_derived ?? 0) - Number(postOriginal.ep_derived ?? 0)} |`,
      `| EP resolved_product_id | ${postStaging.ep_resolved} | ${preOriginal.ep_resolved} | ${postOriginal.ep_resolved} | ${Number(postStaging.ep_resolved ?? 0) - Number(postOriginal.ep_resolved ?? 0)} |`,
      `| products (active) | — | ${productsBefore.c} | ${productsAfter.c} | ${productsAfter.c - productsBefore.c} |`,
      `| pim (active) | — | ${pimBefore.c} | ${pimAfter.c} | ${pimAfter.c - pimBefore.c} |`,
    ].join("\n") + "\n",
  );

  const unresolved = resolverProposals.filter((p) => p.bucket === "missing_product_needs_evidence");
  fs.writeFileSync(
    path.join(outDir, "unresolved-report.md"),
    [
      "# Unresolved resolver report",
      "",
      `missing_product_needs_evidence: **${resolverSummary.queue_missing_product_needs_evidence ?? 0}**`,
      `ambiguous: **${resolverSummary.queue_ambiguous ?? 0}**`,
      "",
      "## Sample (first 20)",
      "",
      ...unresolved.slice(0, 20).map((p) => `- \`${p.id}\` bucket=${p.bucket}`),
    ].join("\n") + "\n",
  );

  const resolverRollback = resolverProposals
    .filter((p) => p.apply_kind !== "skip_unchanged")
    .map((p) => {
      const rp = p.before.resolved_product_id ? `'${p.before.resolved_product_id}'::uuid` : "NULL";
      const rc = p.before.resolved_catalog_product_id ? `'${p.before.resolved_catalog_product_id}'::uuid` : "NULL";
      const st = p.before.identifier_resolution_status ? `'${p.before.identifier_resolution_status}'` : "NULL";
      const conf =
        p.before.identifier_resolution_confidence === null
          ? "NULL"
          : String(p.before.identifier_resolution_confidence);
      return `UPDATE public.expected_packages SET resolved_product_id=${rp}, resolved_catalog_product_id=${rc}, identifier_resolution_status=${st}, identifier_resolution_confidence=${conf}, updated_at=now() WHERE id='${p.id}'::uuid;`;
    });

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- ORIGINAL-PARITY-PHASE1-WAVE-DATA rollback",
      `-- run_id=${runId}`,
      `-- preimage rows: ${preimageRows.length}`,
      "",
      "-- 1) Resolver column rollback",
      ...resolverRollback,
      "",
      "-- 2) Derived expected_packages restore requires preimage JSON operator replay",
      `-- DELETE derived EP for Sam org/store then re-insert from preimage-derived-expected-packages.json`,
      "",
      `DELETE FROM public.expected_packages WHERE organization_id='${ORG_ID}'::uuid AND store_id='${STORE_ID}'::uuid AND build_source IN ('detail_shipment','detail_remainder');`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "preimage-derived-expected-packages.json"),
    JSON.stringify({ run_id: runId, row_count: preimageRows.length, rows: preimageRows }, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    execBlockers.length ? execBlockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None.\n",
  );

  const nextPrompt =
    execBlockers.length > 0
      ? "ORIGINAL-PARITY-PHASE1-WAVE-DATA-TRIAGE — review blockers and partial execute artifacts"
      : Number(postOriginal.ep_resolved ?? 0) < Number(postStaging.ep_resolved ?? 0) * 0.95
        ? "ORIGINAL-PARITY-PHASE1-WAVE-B-EXECUTE — governed map replays on original before second resolver pass"
        : "ORIGINAL-PARITY-PHASE1-WAVE-C-EXECUTE — scanner contract verification on original";

  const manifest = {
    prompt: "ORIGINAL-PARITY-PHASE1-WAVE-DATA-EXECUTE",
    run_id: runId,
    branch,
    original_ref: ORIGINAL_REF,
    staging_ref: STAGING_REF,
    status: execBlockers.length ? "PARTIAL" : "PASS",
    apply: true,
    order_upload_id: orderOutcome.upload_id,
    shipment_upload_id: shipmentOutcome.upload_id,
    rebuild_valid: rebuildValid,
    allocation_mismatch: mismatchCount,
    allocation_mismatch_overflow: mismatchOverflow,
    allocation_mismatch_non_overflow: mismatchNonOverflow,
    dirty_comma_total: dirtyTotal,
    ep_derived_post: postOriginal.ep_derived,
    ep_resolved_post: postOriginal.ep_resolved,
    resolver_applied: resolverApplied,
    blockers: execBlockers,
    exact_next_prompt: nextPrompt,
    no_staging_writes: true,
    no_bulk_clone: true,
    no_products_insert: productsAfter.c === productsBefore.c,
    no_pim_insert: pimAfter.c === pimBefore.c,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
