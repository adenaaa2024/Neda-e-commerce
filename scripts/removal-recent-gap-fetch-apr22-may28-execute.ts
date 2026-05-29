/**
 * REMOVAL RECENT GAP FETCH — 2026-04-22 → 2026-05-28 (fetch + raw upload only)
 *
 *   npx tsx scripts/removal-recent-gap-fetch-apr22-may28-execute.ts
 *   npx tsx scripts/removal-recent-gap-fetch-apr22-may28-execute.ts --run-id=20260529T120000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-9-month-backfill-fetch-approval.md";
const OUT_BASE = ".cursor/audit-reports/removal-recent-gap-fetch-apr22-may28";
const WINDOW = {
  start: "2026-04-22T00:00:00.000Z",
  end: "2026-05-28T23:59:59.999Z",
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

function parseTsv(text: string): number {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return Math.max(0, lines.length - 1);
}

async function countRowsForUpload(uploadId: string): Promise<number> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data, error } = await supabase
    .from("raw_report_uploads")
    .select("metadata")
    .eq("id", uploadId)
    .maybeSingle();
  if (error || !data) return 0;
  const meta = data.metadata as Record<string, unknown> | null;
  const sr =
    meta?.source_run && typeof meta.source_run === "object"
      ? (meta.source_run as Record<string, unknown>)
      : null;
  const archive =
    sr?.archive && typeof sr.archive === "object"
      ? (sr.archive as Record<string, unknown>)
      : null;
  const objectKey = String(archive?.object_key ?? "");
  if (!objectKey) return 0;
  const { data: blob, error: dlErr } = await supabase.storage.from("raw-reports").download(objectKey);
  if (dlErr || !blob) return 0;
  return parseTsv(await blob.text());
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const approvalText = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const stagingOk = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(approvalText);
  const fetchOk = /APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH\s*=\s*true/i.test(approvalText);
  if (!stagingOk || !fetchOk) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), "- Approval flags not true\n");
    process.exit(1);
  }

  const fetchArgs = [
    "tsx",
    "scripts/sp-api-removal-reports-fetch-execute.ts",
    "--backfill-9month",
    `--run-id=${runId}`,
    `--out-base=${OUT_BASE}`,
    `--window-start=${WINDOW.start}`,
    `--window-end=${WINDOW.end}`,
  ];

  let fetchExit = 0;
  try {
    execSync(`npx ${fetchArgs.join(" ")}`, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });
  } catch {
    fetchExit = 1;
  }

  const summaryPath = path.join(outDir, "synthetic-upload-summary.json");
  const orderMdPath = path.join(outDir, "fetch-result-removal-order.md");
  const shipMdPath = path.join(outDir, "fetch-result-removal-shipment.md");

  let orderUploadId: string | null = null;
  let shipmentUploadId: string | null = null;
  let orderReportId: string | null = null;
  let shipmentReportId: string | null = null;
  let orderFetched = false;
  let shipmentFetched = false;
  let apiErrors = 0;

  if (fs.existsSync(summaryPath)) {
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as {
      uploads?: { label: string; upload_id: string }[];
      failed_placeholders?: { error?: string; error_code?: string }[];
    };
    for (const u of summary.uploads ?? []) {
      if (u.label === "removal_order") orderUploadId = u.upload_id;
      if (u.label === "removal_shipment") shipmentUploadId = u.upload_id;
    }
    apiErrors = (summary.failed_placeholders ?? []).filter((f) => f.error || f.error_code).length;
  }

  const extract = (md: string, key: string): string | null => {
    const re = new RegExp(`\\| ${key} \\| \`([^\`]+)\` \\|`);
    const m = md.match(re);
    return m?.[1] ?? null;
  };

  if (fs.existsSync(orderMdPath)) {
    const md = fs.readFileSync(orderMdPath, "utf8");
    orderFetched = /\| Fetched \| \*\*yes\*\* \|/.test(md);
    orderUploadId = orderUploadId ?? extract(md, "upload_id");
    orderReportId = extract(md, "report_id");
    if (extract(md, "error") && extract(md, "error") !== "—") apiErrors++;
  }
  if (fs.existsSync(shipMdPath)) {
    const md = fs.readFileSync(shipMdPath, "utf8");
    shipmentFetched = /\| Fetched \| \*\*yes\*\* \|/.test(md);
    shipmentUploadId = shipmentUploadId ?? extract(md, "upload_id");
    shipmentReportId = extract(md, "report_id");
    if (extract(md, "error") && extract(md, "error") !== "—") apiErrors++;
  }

  let orderRows = 0;
  let shipmentRows = 0;
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    if (orderUploadId && orderFetched) orderRows = await countRowsForUpload(orderUploadId);
    if (shipmentUploadId && shipmentFetched) shipmentRows = await countRowsForUpload(shipmentUploadId);
  }

  const exactNextPrompt =
    "REMOVAL-RECENT-GAP-DOMAIN-SYNC-APR22-MAY28 — domain sync + rebuild + chunk resolver for uploads from this fetch only (separate approval); HOLD chunk2 domain sync until recent gap synced";

  fs.writeFileSync(
    path.join(outDir, "row-counts.json"),
    JSON.stringify({ order_rows: orderRows, shipment_rows: shipmentRows }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "row-counts.md"),
    [`# Row counts`, ``, `| Report | Rows |`, `|--------|------|`, `| REMOVAL_ORDER | ${orderRows} |`, `| REMOVAL_SHIPMENT | ${shipmentRows} |`, ``].join(
      "\n",
    ),
  );
  fs.writeFileSync(
    path.join(outDir, "raw-upload-ids.json"),
    JSON.stringify(
      {
        order_upload_id: orderUploadId,
        shipment_upload_id: shipmentUploadId,
        upload_ids: [orderUploadId, shipmentUploadId].filter(Boolean),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(outDir, "api-errors.md"),
    apiErrors === 0
      ? "# API errors\n\n- None\n"
      : `# API errors\n\n- ${apiErrors} error(s) — see fetch-result-removal-order.md and fetch-result-removal-shipment.md\n`,
  );

  const status =
    fetchExit !== 0 || !orderFetched || !shipmentFetched
      ? fetchExit !== 0 && (orderFetched || shipmentFetched)
        ? "PARTIAL"
        : "FAIL"
      : "PASS";

  const manifest = {
    prompt: "REMOVAL-RECENT-GAP-FETCH-APR22-MAY28",
    run_id: runId,
    staging_ref: STAGING_REF,
    status,
    window: WINDOW,
    order_report_fetched: orderFetched,
    shipment_report_fetched: shipmentFetched,
    order_rows: orderRows,
    shipment_rows: shipmentRows,
    order_upload_id: orderUploadId,
    shipment_upload_id: shipmentUploadId,
    order_report_id: orderReportId,
    shipment_report_id: shipmentReportId,
    api_errors: apiErrors,
    synthetic_uploads_count: [orderFetched, shipmentFetched].filter(Boolean).length,
    upload_ids: [orderUploadId, shipmentUploadId].filter(Boolean),
    exact_next_prompt: exactNextPrompt,
    forbidden: {
      run_pipeline: false,
      domain_sync: true,
      rebuild_expected_packages: true,
      resolver: true,
      product_create: true,
      original_writes: true,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify({ ok: status === "PASS", outDir: path.relative(process.cwd(), outDir), ...manifest }, null, 2));
  if (status !== "PASS") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
