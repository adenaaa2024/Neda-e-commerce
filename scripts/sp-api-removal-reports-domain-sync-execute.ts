/**
 * SP-API-REMOVAL-REPORTS-DOMAIN-SYNC-EXECUTE — staging only
 *
 *   npx tsx scripts/sp-api-removal-reports-domain-sync-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createRequire, type Module } from "node:module";
import pg from "pg";

import {
  queryEpAllocationMismatchBreakdown,
  rebuildValidFromBreakdown,
} from "../lib/removal/ep-allocation-mismatch-breakdown";
import { evaluateExplicitRebuildSkipFromDb } from "../lib/removal/expected-packages-explicit-rebuild-guard";
import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v3";
const APPROVAL_PATH = ".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md";
const FETCH_RUN = "20260527T202818Z";
const SYNC_PLAN_RUN = "20260527T203758Z";
const OUT_BASE = ".cursor/audit-reports/sp-api-removal-reports-domain-sync-execute";

const DEFAULT_ORDER_UPLOAD_ID = "7a7a9a49-7edf-4ace-a77b-b17f9882f8a2";
const DEFAULT_SHIPMENT_UPLOAD_ID = "839817be-f65f-4cb8-9fc0-2cda49a3ab67";

function argValue(prefix: string): string | null {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.split("=")[1]!.trim() : null;
}

function uploadIdFromArgOrEnv(
  argPrefix: string,
  envKey: string,
  fallback: string,
): string {
  return (
    argValue(argPrefix) ??
    process.env[envKey]?.trim() ??
    fallback
  );
}

type EpCounts = {
  total: number;
  detail_shipment: number;
  detail_remainder: number;
  derived_total: number;
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

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runVal = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const syncVal = /APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC\s*=\s*true/i.test(text);
  return {
    valid: runVal && syncVal,
    raw: {
      APPROVED_TO_RUN_STAGING: runVal ? "true" : "false",
      APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC: syncVal ? "true" : "false",
    },
  };
}

async function domainCounts(client: pg.Client): Promise<{ removals: number; shipments: number }> {
  const r = await client.query(
    `SELECT
      (SELECT COUNT(*)::int FROM public.amazon_removals
       WHERE organization_id = $1::uuid AND store_id = $2::uuid) AS removals,
      (SELECT COUNT(*)::int FROM public.amazon_removal_shipments
       WHERE organization_id = $1::uuid AND store_id = $2::uuid) AS shipments`,
    [ORG_ID, STORE_ID],
  );
  return r.rows[0] as { removals: number; shipments: number };
}

async function uploadDomainCount(
  client: pg.Client,
  uploadId: string,
  table: "amazon_removals" | "amazon_removal_shipments",
): Promise<number> {
  const r = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.${table} WHERE upload_id = $1::uuid`,
    [uploadId],
  );
  return (r.rows[0] as { c: number }).c;
}

async function stagingCount(client: pg.Client, uploadId: string): Promise<number> {
  const r = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.amazon_staging WHERE upload_id = $1::uuid`,
    [uploadId],
  );
  return (r.rows[0] as { c: number }).c;
}

async function epCounts(client: pg.Client): Promise<EpCounts> {
  const r = await client.query(
    `SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE build_source = 'detail_shipment')::int AS detail_shipment,
      COUNT(*) FILTER (WHERE build_source = 'detail_remainder')::int AS detail_remainder,
      COUNT(*) FILTER (WHERE build_source IN ('detail_shipment','detail_remainder'))::int AS derived_total
    FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG_ID, STORE_ID],
  );
  return r.rows[0] as EpCounts;
}

async function tableCount(client: pg.Client, table: string): Promise<number> {
  const r = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.${table}
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG_ID, STORE_ID],
  );
  return (r.rows[0] as { c: number }).c;
}


async function ensureRebuildIndexes(client: pg.Client): Promise<void> {
  const idx = await client.query(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN (
         'uq_expected_packages_canonical_cross_file',
         'uq_expected_packages_canonical_legacy',
         'uq_expected_packages_derived_pair'
       )`,
  );
  const names = new Set((idx.rows as Array<{ indexname: string }>).map((r) => r.indexname));
  await client.query(
    `UPDATE public.expected_packages SET build_source = 'legacy' WHERE build_source IS NULL`,
  );
  if (names.has("uq_expected_packages_canonical_cross_file")) {
    await client.query(`DROP INDEX IF EXISTS public.uq_expected_packages_canonical_cross_file`);
  }
  if (!names.has("uq_expected_packages_canonical_legacy")) {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_expected_packages_canonical_legacy
        ON public.expected_packages (
          organization_id, store_id, order_id, order_type, sku, fnsku, disposition
        ) NULLS NOT DISTINCT WHERE build_source = 'legacy'
    `);
  }
  if (!names.has("uq_expected_packages_derived_pair")) {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_expected_packages_derived_pair
        ON public.expected_packages (
          organization_id, source_detail_row_id, source_shipment_row_id
        ) NULLS NOT DISTINCT
        WHERE build_source IN ('detail_shipment', 'detail_remainder')
    `);
  }
}

async function runPipelineForUpload(
  client: pg.Client,
  uploadId: string,
  reportType: string,
): Promise<PipelineOutcome> {
  const domainTable =
    reportType === "REMOVAL_ORDER" ? "amazon_removals" : "amazon_removal_shipments";
  const stagingBefore = await stagingCount(client, uploadId);
  const domainBefore = await uploadDomainCount(client, uploadId, domainTable);

  const { supabaseServer } = await import("../lib/supabase-server");
  const { parseSourceRun } = await import("../lib/amazon/reports-api-source-run");
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

  const stagingAfter = await stagingCount(client, uploadId);
  const domainAfter = await uploadDomainCount(client, uploadId, domainTable);

  return {
    upload_id: uploadId,
    report_type: reportType,
    ok: pipe.ok,
    state: pipe.state,
    error: pipe.ok ? undefined : pipe.error,
    error_code: pipe.ok ? undefined : pipe.error_code,
    staging_before: stagingBefore,
    staging_after: stagingAfter,
    domain_before: domainBefore,
    domain_after: domainAfter,
    wall_ms: wallMs,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const ORDER_UPLOAD_ID = uploadIdFromArgOrEnv(
    "--order-upload-id=",
    "REMOVAL_AUTOMATION_ORDER_UPLOAD_ID",
    DEFAULT_ORDER_UPLOAD_ID,
  );
  const SHIPMENT_UPLOAD_ID = uploadIdFromArgOrEnv(
    "--shipment-upload-id=",
    "REMOVAL_AUTOMATION_SHIPMENT_UPLOAD_ID",
    DEFAULT_SHIPMENT_UPLOAD_ID,
  );
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH && !process.argv.includes("--manual"))
    blockers.push(`Branch must be ${REQUIRED_BRANCH}, got ${branch}`);
  if (!approval.valid) blockers.push("Approval flags not both true");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
      blockers.push(`DB URL must target staging ${STAGING_REF}`);
    }
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original project");
  }
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (supaUrl && refFromSupabaseUrl(supaUrl) !== STAGING_REF) {
    blockers.push(`NEXT_PUBLIC_SUPABASE_URL must be staging ${STAGING_REF}`);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    blockers.push("SUPABASE_SERVICE_ROLE_KEY missing");
  }

  const promoPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/sp-api-removal-reports-sync-plan",
    SYNC_PLAN_RUN,
    "product-promotion-needed.json",
  );
  let promoCandidates = { count: 45, candidates: [] as unknown[] };
  if (fs.existsSync(promoPath)) {
    promoCandidates = JSON.parse(fs.readFileSync(promoPath, "utf8")) as typeof promoCandidates;
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      "| Flag | Value |",
      "|------|-------|",
      `| APPROVED_TO_RUN_STAGING | ${approval.raw.APPROVED_TO_RUN_STAGING} |`,
      `| APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC | ${approval.raw.APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC} |`,
      `| approval_file | \`${APPROVAL_PATH}\` |`,
      `| valid | **${approval.valid}** |`,
      `| staging_ref | \`${STAGING_REF}\` |`,
      `| fetch_run | \`${FETCH_RUN}\` |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "raw-upload-ids-used.json"),
    JSON.stringify(
      {
        fetch_run: FETCH_RUN,
        sync_plan_run: SYNC_PLAN_RUN,
        organization_id: ORG_ID,
        store_id: STORE_ID,
        uploads: [
          { label: "removal_order", upload_id: ORDER_UPLOAD_ID, report_type: "REMOVAL_ORDER" },
          { label: "removal_shipment", upload_id: SHIPMENT_UPLOAD_ID, report_type: "REMOVAL_SHIPMENT" },
        ],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "product-promotion-candidates.json"),
    JSON.stringify(promoCandidates, null, 2),
  );

  if (blockers.length && apply) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    throw new Error(`Blocked: ${blockers.join("; ")}`);
  }

  if (!apply) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run only; pass `--apply` to execute domain sync + rebuild.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt: "SP-API-REMOVAL-REPORTS-DOMAIN-SYNC-EXECUTE",
          run_id: runId,
          status: blockers.length ? "BLOCKED" : "DRY_RUN",
          apply: false,
          exact_next_prompt: "npx tsx scripts/sp-api-removal-reports-domain-sync-execute.ts --apply",
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: !blockers.length, outDir, apply: false, blockers }, null, 2));
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '600s'");

  const beforeDomain = await domainCounts(client);
  const beforeEp = await epCounts(client);
  const productsBefore = await tableCount(client, "products");
  const pimBefore = await tableCount(client, "product_identifier_map");

  const preimageRes = await client.query(
    `SELECT row_to_json(t) AS row FROM (
      SELECT * FROM public.expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND build_source IN ('detail_shipment', 'detail_remainder')
    ) t`,
    [ORG_ID, STORE_ID],
  );
  const preimageRows = (preimageRes.rows as Array<{ row: Record<string, unknown> }>).map((r) => r.row);
  const preimagePath = path.join(outDir, "preimage-derived-expected-packages.json");
  fs.writeFileSync(
    preimagePath,
    JSON.stringify(
      { run_id: runId, row_count: preimageRows.length, rows: preimageRows },
      null,
      2,
    ),
  );

  const orderPipe = await runPipelineForUpload(client, ORDER_UPLOAD_ID, "REMOVAL_ORDER");
  const shipPipe = await runPipelineForUpload(client, SHIPMENT_UPLOAD_ID, "REMOVAL_SHIPMENT");

  const afterSyncDomain = await domainCounts(client);
  const newOrderRows = afterSyncDomain.removals - beforeDomain.removals;
  const newShipmentRows = afterSyncDomain.shipments - beforeDomain.shipments;

  const skipDecision = await evaluateExplicitRebuildSkipFromDb({
    client,
    organizationId: ORG_ID,
    rebuildExpectedPackages: true,
    orderPipelineOk: orderPipe.ok,
    shipmentPipelineOk: shipPipe.ok,
    orderUploadId: ORDER_UPLOAD_ID,
    shipmentUploadId: SHIPMENT_UPLOAD_ID,
  });

  let rebuild: RebuildResult | null = null;
  if (!skipDecision.skip) {
    await ensureRebuildIndexes(client);
    const rebuildRes = await client.query(
      `SELECT * FROM public.rebuild_expected_packages_from_removals($1::uuid, $2::uuid)`,
      [ORG_ID, STORE_ID],
    );
    rebuild = rebuildRes.rows[0] as RebuildResult;
  }

  const afterEp = await epCounts(client);
  const productsAfter = await tableCount(client, "products");
  const pimAfter = await tableCount(client, "product_identifier_map");
  const mismatchBreakdown = await queryEpAllocationMismatchBreakdown(client, ORG_ID, STORE_ID);
  const mismatchCount = mismatchBreakdown.total;
  const rebuildValid = rebuildValidFromBreakdown(mismatchBreakdown);

  await client.end();

  const pipelineOk = orderPipe.ok && shipPipe.ok;
  const execBlockers: string[] = [];
  if (!orderPipe.ok) execBlockers.push(`REMOVAL_ORDER pipeline failed: ${orderPipe.error}`);
  if (!shipPipe.ok) execBlockers.push(`REMOVAL_SHIPMENT pipeline failed: ${shipPipe.error}`);
  if (!rebuildValid) {
    execBlockers.push(
      `Rebuild verify FAIL: non-overflow allocation mismatch=${mismatchBreakdown.non_overflow} (total=${mismatchCount}, overflow=${mismatchBreakdown.overflow})`,
    );
  }
  if (productsAfter !== productsBefore) execBlockers.push("products count changed (forbidden)");
  if (pimAfter !== pimBefore) execBlockers.push("product_identifier_map count changed (forbidden)");

  fs.writeFileSync(
    path.join(outDir, "domain-insert-update-summary.json"),
    JSON.stringify(
      {
        before_domain: beforeDomain,
        after_sync_domain: afterSyncDomain,
        new_order_rows_net: newOrderRows,
        new_shipment_rows_net: newShipmentRows,
        plan_expected: { new_order: 179, new_shipment: 397 },
        pipelines: [orderPipe, shipPipe],
        explicit_rebuild_skip: skipDecision,
        products: { before: productsBefore, after: productsAfter },
        product_identifier_map: { before: pimBefore, after: pimAfter },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "domain-sync-result.md"),
    [
      "# Domain sync result",
      "",
      `**Status:** ${pipelineOk ? "PASS" : "FAIL"}`,
      "",
      "## REMOVAL_ORDER",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| upload_id | \`${ORDER_UPLOAD_ID}\` |`,
      `| pipeline ok | **${orderPipe.ok}** |`,
      `| final state | \`${orderPipe.state}\` |`,
      `| staging before → after | ${orderPipe.staging_before} → ${orderPipe.staging_after} |`,
      `| domain rows (upload_id) before → after | ${orderPipe.domain_before} → ${orderPipe.domain_after} |`,
      `| wall_ms | ${orderPipe.wall_ms} |`,
      orderPipe.error ? `| error | ${orderPipe.error} |` : "",
      "",
      "## REMOVAL_SHIPMENT",
      "",
      `| upload_id | \`${SHIPMENT_UPLOAD_ID}\` |`,
      `| pipeline ok | **${shipPipe.ok}** |`,
      `| final state | \`${shipPipe.state}\` |`,
      `| staging before → after | ${shipPipe.staging_before} → ${shipPipe.staging_after} |`,
      `| domain rows (upload_id) before → after | ${shipPipe.domain_before} → ${shipPipe.domain_after} |`,
      `| wall_ms | ${shipPipe.wall_ms} |`,
      shipPipe.error ? `| error | ${shipPipe.error} |` : "",
      "",
      "## Net domain delta (org/store totals)",
      "",
      `| Table | Before | After sync | Delta |`,
      `|-------|--------|------------|-------|`,
      `| amazon_removals | ${beforeDomain.removals} | ${afterSyncDomain.removals} | **+${newOrderRows}** |`,
      `| amazon_removal_shipments | ${beforeDomain.shipments} | ${afterSyncDomain.shipments} | **+${newShipmentRows}** |`,
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "expected-packages-rebuild-result.md"),
    [
      "# Expected packages rebuild result",
      "",
      "## Before / after",
      "",
      "| Metric | Before | After | Delta |",
      "|--------|--------|-------|-------|",
      `| derived total | ${beforeEp.derived_total} | ${afterEp.derived_total} | ${afterEp.derived_total - beforeEp.derived_total} |`,
      `| detail_shipment | ${beforeEp.detail_shipment} | ${afterEp.detail_shipment} | ${afterEp.detail_shipment - beforeEp.detail_shipment} |`,
      `| detail_remainder | ${beforeEp.detail_remainder} | ${afterEp.detail_remainder} | ${afterEp.detail_remainder - beforeEp.detail_remainder} |`,
      "",
      "## rebuild_expected_packages_from_removals output",
      "",
      skipDecision.skip
        ? `Explicit rebuild **skipped** (${skipDecision.reason ?? "unknown"}; covered upload \`${skipDecision.covered_upload_id ?? "n/a"}\`). Pipeline hook already rebuilt.`
        : [
            "| Field | Value |",
            "|-------|------:|",
            `| detail_lines_in_scope | ${rebuild?.detail_lines_in_scope ?? 0} |`,
            `| matched_rows_upserted | ${rebuild?.matched_rows_upserted ?? 0} |`,
            `| remainder_rows_upserted | ${rebuild?.remainder_rows_upserted ?? 0} |`,
            `| overflow_lines | ${rebuild?.overflow_lines ?? 0} |`,
            `| obsolete_rows_deleted | ${rebuild?.obsolete_rows_deleted ?? 0} |`,
          ].join("\n"),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "rebuild-verify-after-sync.md"),
    [
      "# Rebuild verify after sync",
      "",
      `| Check | Result |`,
      `|-------|--------|`,
      `| rebuild_valid | **${rebuildValid ? "yes" : "no"}** |`,
      `| allocation mismatch (total / overflow / non-overflow) | **${mismatchCount} / ${mismatchBreakdown.overflow} / ${mismatchBreakdown.non_overflow}** |`,
      `| products unchanged | **${productsAfter === productsBefore}** (${productsBefore} → ${productsAfter}) |`,
      `| product_identifier_map unchanged | **${pimAfter === pimBefore}** (${pimBefore} → ${pimAfter}) |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Rollback for SP-API removal domain sync execute (staging only)",
      `-- run_id=${runId}`,
      `-- preimage: ${path.relative(process.cwd(), preimagePath).replace(/\\/g, "/")}`,
      "",
      "BEGIN;",
      "",
      "-- 1. Remove domain rows landed from SP-API uploads (lineage by upload_id)",
      `DELETE FROM public.amazon_removal_shipments WHERE upload_id = '${SHIPMENT_UPLOAD_ID}'::uuid;`,
      `DELETE FROM public.amazon_removals WHERE upload_id = '${ORDER_UPLOAD_ID}'::uuid;`,
      "",
      "-- 2. Restore derived expected_packages from preimage JSON",
      `DELETE FROM public.expected_packages`,
      `WHERE organization_id = '${ORG_ID}'::uuid`,
      `  AND store_id = '${STORE_ID}'::uuid`,
      `  AND build_source IN ('detail_shipment', 'detail_remainder');`,
      "-- Re-insert rows from preimage-derived-expected-packages.json via operator restore tool",
      "",
      "-- 3. Optional: clear staging for re-import",
      `DELETE FROM public.amazon_staging WHERE upload_id IN ('${ORDER_UPLOAD_ID}'::uuid, '${SHIPMENT_UPLOAD_ID}'::uuid);`,
      "",
      "COMMIT;",
    ].join("\n") + "\n",
  );

  const nextPrompt =
    pipelineOk && rebuildValid
      ? "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-DRYRUN — verify resolver dry-run after SP-API domain sync, then REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-EXECUTE if approved"
      : "SP-API-REMOVAL-REPORTS-DOMAIN-SYNC-EXECUTE — fix pipeline/rebuild failures and re-run";

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [...blockers, ...execBlockers].length
      ? [...blockers, ...execBlockers].map((b) => `- ${b}`).join("\n") + "\n"
      : "- None\n",
  );

  const status =
    blockers.length || execBlockers.length ? "FAIL" : pipelineOk && rebuildValid ? "PASS" : "FAIL";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SP-API-REMOVAL-REPORTS-DOMAIN-SYNC-EXECUTE",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        fetch_run: FETCH_RUN,
        status,
        new_order_rows: newOrderRows,
        new_shipment_rows: newShipmentRows,
        expected_packages_before: beforeEp.derived_total,
        expected_packages_after: afterEp.derived_total,
        rebuild_valid: rebuildValid,
        allocation_mismatch_count: mismatchCount,
        allocation_mismatch_overflow: mismatchBreakdown.overflow,
        allocation_mismatch_non_overflow: mismatchBreakdown.non_overflow,
        product_promotion_candidates: promoCandidates.count,
        exact_next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: status === "PASS",
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        new_order_rows: newOrderRows,
        new_shipment_rows: newShipmentRows,
        expected_packages_before: beforeEp.derived_total,
        expected_packages_after: afterEp.derived_total,
        rebuild_valid: rebuildValid,
        product_promotion_candidates: promoCandidates.count,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  if (status !== "PASS") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
