/**
 * SP-API-REMOVAL-REPORTS-FETCH-EXECUTE — staging fetch (order then shipment)
 *
 *   npx tsx scripts/sp-api-removal-reports-fetch-execute.ts --run-id=<UTC_Z>
 *   npx tsx scripts/sp-api-removal-reports-fetch-execute.ts --window-start=2025-01-01T00:00:00Z --window-end=2026-05-27T23:59:59Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createRequire, type Module } from "node:module";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

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
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md";
const OUT_BASE = ".cursor/audit-reports/sp-api-removal-reports-fetch-execute";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

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

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const staging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const fetch = /APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH\s*=\s*true/i.test(text);
  return {
    valid: staging && fetch,
    raw: {
      APPROVED_TO_RUN_STAGING: staging ? "true" : "false",
      APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH: fetch ? "true" : "false",
    },
  };
}

function defaultWindow(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function removalActivityWindow(
  organizationId: string,
  storeId: string,
): Promise<{ start: string; end: string } | null> {
  const supabaseServer = await getSupabase();
  const { data, error } = await supabaseServer
    .from("amazon_removals")
    .select("order_date")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .not("order_date", "is", null)
    .order("order_date", { ascending: true })
    .limit(1);
  const { data: dataMax, error: errMax } = await supabaseServer
    .from("amazon_removals")
    .select("order_date")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .not("order_date", "is", null)
    .order("order_date", { ascending: false })
    .limit(1);
  if (error || errMax || !data?.[0] || !dataMax?.[0]) return null;
  const minD = String((data[0] as { order_date?: string }).order_date ?? "").trim();
  const maxD = String((dataMax[0] as { order_date?: string }).order_date ?? "").trim();
  if (!minD || !maxD) return null;
  const start = new Date(minD);
  start.setUTCDate(start.getUTCDate() - 7);
  const end = new Date(maxD);
  end.setUTCDate(end.getUTCDate() + 7);
  const now = new Date();
  if (end > now) end.setTime(now.getTime());
  return { start: start.toISOString(), end: end.toISOString() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchSucceeded(state: string | null): boolean {
  return state === "synthetic_upload_ready" || state === "complete";
}

async function getSupabase() {
  const { supabaseServer } = await import("../lib/supabase-server");
  return supabaseServer;
}

async function loadUploadSummary(
  uploadId: string,
  organizationId: string,
): Promise<{
  state: string | null;
  content_sha256: string | null;
  byte_length: number | null;
  report_id: string | null;
  idempotency_key: string | null;
  last_error_code: string | null;
  last_error_detail: string | null;
}> {
  const supabaseServer = await getSupabase();
  const { data, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata, status")
    .eq("id", uploadId)
    .eq("organization_id", organizationId)
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
      typeof meta?.file_size_bytes === "number"
        ? meta.file_size_bytes
        : sr?.archive?.byte_length ?? null,
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

  const summary = uploadId ? await loadUploadSummary(uploadId, ORG_ID) : null;
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

function mdSection(title: string, outcome: FetchOutcome, window: { start: string; end: string }): string {
  return [
    `# ${title}`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| SP report type | \`${outcome.sp_report_type}\` |`,
    `| Upload report_type | \`${outcome.upload_report_type}\` |`,
    `| Window | \`${window.start}\` → \`${window.end}\` |`,
    `| Fetched | **${outcome.fetched ? "yes" : "no"}** |`,
    `| upload_id | \`${outcome.upload_id ?? "—"}\` |`,
    `| source_run_id | \`${outcome.source_run_id ?? "—"}\` |`,
    `| final_state | \`${outcome.final_state ?? "—"}\` |`,
    `| idempotent_replay | ${outcome.idempotent_replay} |`,
    `| content_sha256 | \`${outcome.content_sha256 ?? "—"}\` |`,
    `| byte_length | ${outcome.byte_length ?? "—"} |`,
    `| report_id | \`${outcome.report_id ?? "—"}\` |`,
    `| resume_rounds | ${outcome.resume_rounds} |`,
    `| error | ${outcome.error ?? "—"} |`,
    `| error_code | ${outcome.error_code ?? "—"} |`,
    "",
    "runPipeline: **false** (fetch-only; no Phase 2–4).",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    blockers.push("Could not read git branch.");
  }
  if (branch !== REQUIRED_BRANCH) {
    blockers.push(`Branch \`${branch}\` !== \`${REQUIRED_BRANCH}\`.`);
  }

  const approval = readApproval();
  if (!approval.valid) {
    blockers.push(`${APPROVAL_PATH}: approval flags not true — STOP.`);
  }

  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() ||
    process.env.STAGING_SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    "";
  const urlRef = refFromSupabaseUrl(supabaseUrl);
  if (!supabaseUrl || !supabaseUrlMatchesStagingRef(supabaseUrl, STAGING_REF)) {
    blockers.push(`Supabase URL ref ${urlRef ?? "missing"} !== staging ${STAGING_REF}.`);
  }
  if (urlRef === ORIGINAL_REF) {
    blockers.push(`Original/production ref ${ORIGINAL_REF} is forbidden.`);
  }
  if (supabaseUrl && !process.env.SUPABASE_URL) {
    process.env.SUPABASE_URL = supabaseUrl;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    blockers.push("SUPABASE_SERVICE_ROLE_KEY missing.");
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `| File | \`${APPROVAL_PATH}\` |`,
      `| Staging ref | \`${STAGING_REF}\` |`,
      `| Branch | \`${branch}\` |`,
      "",
      "## Flags",
      "",
      "```text",
      ...Object.entries(approval.raw).map(([k, v]) => `${k}=${v}`),
      "```",
      "",
      `Valid for execute: **${approval.valid}**`,
    ].join("\n") + "\n",
  );

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt: "SP-API-REMOVAL-REPORTS-FETCH-EXECUTE",
          run_id: runId,
          status: "BLOCKED",
          blockers,
          order_fetched: false,
          shipment_fetched: false,
          synthetic_uploads_count: 0,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: false, outDir, blockers }, null, 2));
    process.exit(1);
  }

  process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
  process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER = "true";
  process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT = "true";
  if (!process.env.ENABLE_IMPORT_DESCRIPTOR_METADATA) {
    process.env.ENABLE_IMPORT_DESCRIPTOR_METADATA = "true";
  }

  const activityWindow = await removalActivityWindow(ORG_ID, STORE_ID);
  const window = {
    start: argValue("--window-start=") ?? activityWindow?.start ?? defaultWindow().start,
    end: argValue("--window-end=") ?? activityWindow?.end ?? defaultWindow().end,
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

  const { runRemovalOrderReportsWorker } = await import("../lib/amazon/reports-api-removal-order-worker");
  const { runRemovalShipmentReportsWorker } = await import(
    "../lib/amazon/reports-api-removal-shipment-worker"
  );

  const orderOutcome = await runFetchUntilReady(
    "removal_order",
    (req) =>
      runRemovalOrderReportsWorker(req, {
        runPipeline: false,
        requestBudgetMs: 55_000,
      }),
    window,
    orderIdem,
  );

  const shipmentOutcome = await runFetchUntilReady(
    "removal_shipment",
    (req) =>
      runRemovalShipmentReportsWorker(req, {
        runPipeline: false,
        requestBudgetMs: 55_000,
      }),
    window,
    shipmentIdem,
  );

  const uploads = [orderOutcome, shipmentOutcome].filter((o) => o.upload_id && o.fetched);
  const placeholderUploads = [orderOutcome, shipmentOutcome].filter((o) => o.upload_id);
  const syntheticSummary = {
    count: uploads.length,
    placeholder_uploads_count: placeholderUploads.length,
    uploads: uploads.map((o) => ({
      label: o.label,
      upload_id: o.upload_id,
      report_type: o.upload_report_type,
      content_sha256: o.content_sha256,
      byte_length: o.byte_length,
      source_run_state: o.final_state,
      idempotency_key: o.idempotency_key,
    })),
    failed_placeholders: placeholderUploads
      .filter((o) => !o.fetched)
      .map((o) => ({
        label: o.label,
        upload_id: o.upload_id,
        final_state: o.final_state,
        report_id: o.report_id,
        error_code: o.error_code,
        error: o.error,
      })),
    run_pipeline: false,
    forbidden: {
      normalized_import: true,
      rebuild_expected_packages: true,
      products_insert: true,
    },
  };

  fs.writeFileSync(
    path.join(outDir, "fetch-result-removal-order.md"),
    mdSection("Removal order detail fetch", orderOutcome, window),
  );
  fs.writeFileSync(
    path.join(outDir, "fetch-result-removal-shipment.md"),
    mdSection("Removal shipment detail fetch", shipmentOutcome, window),
  );
  fs.writeFileSync(
    path.join(outDir, "synthetic-upload-summary.json"),
    JSON.stringify(syntheticSummary, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "idempotency-proof.md"),
    [
      "# Idempotency proof",
      "",
      "Keys are SHA-256 of org|provider|operation|report_type|window|marketplaces|store.",
      "",
      "| Report | idempotency_key |",
      "|--------|-----------------|",
      `| REMOVAL_ORDER | \`${orderOutcome.idempotency_key ?? orderIdem}\` |`,
      `| REMOVAL_SHIPMENT | \`${shipmentOutcome.idempotency_key ?? shipmentIdem}\` |`,
      "",
      "Re-run with the same window should attach to the same upload row when non-terminal.",
    ].join("\n") + "\n",
  );

  const execBlockers: string[] = [];
  if (orderOutcome.error_code === "report_fatal" || shipmentOutcome.error_code === "report_fatal") {
    execBlockers.push(
      "Amazon returned processingStatus=FATAL for both reports — verify SP-API app roles include FBA Reports, seller has FBA removal activity in window, and credentials match staging data seller.",
    );
  }
  if (!orderOutcome.fetched) {
    if (orderOutcome.final_state === "polling") {
      execBlockers.push(
        `Removal order still polling (upload ${orderOutcome.upload_id}) — re-run this script to resume.`,
      );
    } else {
      execBlockers.push(
        `Removal order fetch failed: ${orderOutcome.error_code ?? orderOutcome.final_state ?? "unknown"} — ${orderOutcome.error ?? "no message"}`,
      );
    }
  }
  if (!shipmentOutcome.fetched) {
    if (shipmentOutcome.final_state === "polling") {
      execBlockers.push(
        `Removal shipment still polling (upload ${shipmentOutcome.upload_id}) — re-run this script to resume.`,
      );
    } else {
      execBlockers.push(
        `Removal shipment fetch failed: ${shipmentOutcome.error_code ?? shipmentOutcome.final_state ?? "unknown"} — ${shipmentOutcome.error ?? "no message"}`,
      );
    }
  }

  fs.writeFileSync(
    path.join(outDir, "implementation-summary.md"),
    [
      "# Implementation summary",
      "",
      "## Added",
      "",
      "- `lib/amazon/reports-api-removal-order-worker.ts`",
      "- `lib/amazon/reports-api-removal-shipment-worker.ts`",
      "- `app/api/settings/imports/reports-api/removal-order/run` + `resume`",
      "- `app/api/settings/imports/reports-api/removal-shipment/run` + `resume`",
      "- Flags: `ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER`, `ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT`",
      "- Profiles: `REMOVAL_ORDER_PULL_PROFILE`, `REMOVAL_SHIPMENT_PULL_PROFILE`",
      "- Fixtures: `tests/fixtures/sp-api-reports/removal-order|removal-shipment`",
      "",
      "## Execute",
      "",
      `- Staging ref: \`${getStagingProjectRef()}\``,
      `- Org / store: \`${ORG_ID}\` / \`${STORE_ID}\``,
      `- Order fetched: **${orderOutcome.fetched}**`,
      `- Shipment fetched: **${shipmentOutcome.fetched}**`,
      `- Synthetic uploads ready: **${syntheticSummary.count}**`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    execBlockers.length ? execBlockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n",
  );

  const nextPrompt =
    "REMOVAL-SHIPMENT-NORMALIZED-IMPORT-STAGING-EXECUTE — run Phase 2–4 on synthetic REMOVAL_ORDER + REMOVAL_SHIPMENT uploads (separate approval), then rebuild_expected_packages_from_removals";

  const manifest = {
    prompt: "SP-API-REMOVAL-REPORTS-FETCH-EXECUTE",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: execBlockers.length ? "PARTIAL" : "PASS",
    order_report_fetched: orderOutcome.fetched,
    shipment_report_fetched: shipmentOutcome.fetched,
    synthetic_uploads_count: syntheticSummary.count,
    upload_ids: uploads.map((u) => u.upload_id),
    window,
    exact_next_prompt: nextPrompt,
    forbidden: {
      run_pipeline: false,
      rebuild_expected_packages: false,
      product_create: false,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: execBlockers.length === 0,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        order_fetched: orderOutcome.fetched,
        shipment_fetched: shipmentOutcome.fetched,
        synthetic_uploads_count: syntheticSummary.count,
        blockers: execBlockers,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  if (execBlockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
