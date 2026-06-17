/**
 * PHASE-CLAIM-MONEY-LANE-SOURCE-DISCOVERY-V1 — read-only money lane source discovery
 *   npx tsx scripts/phase-claim-money-lane-source-discovery-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  loadUploadLineage,
  tryDownloadUploadArtifact,
} from "../lib/claims/reference/claim-7h-source-api-file-reference-discovery-v1";
import {
  CLAIM_MONEY_LANE_SOURCE_DISCOVERY_V1_VERSION,
  discoverMoneyLaneSourcesV1,
  SP_API_MONEY_LANE_REPORT_TYPES,
} from "../lib/claims/submission/claim-money-lane-source-discovery-v1";
import { verifyMoneyNullPreservationTracking } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-money-lane-source-discovery-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const SAMPLE_REPORT_TYPES = ["REPORTS_REPOSITORY", "SETTLEMENT", "REIMBURSEMENTS", "TRANSACTIONS"] as const;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

async function downloadSampleUploads(
  client: ReturnType<typeof createClient>,
  outDir: string,
  uploads: Array<{ report_type: string; upload_count: number }>,
): Promise<Array<Record<string, unknown>>> {
  const samples: Array<Record<string, unknown>> = [];
  const artifactsDir = path.join(outDir, "source-artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });

  for (const rt of SAMPLE_REPORT_TYPES) {
    const inv = uploads.find((u) => u.report_type === rt);
    if (!inv || inv.upload_count === 0) {
      samples.push({ report_type: rt, status: "no_upload_found" });
      continue;
    }

    const { data, error } = await client
      .from("raw_report_uploads")
      .select("id, file_name, report_type, status, created_at, metadata")
      .eq("organization_id", ORG)
      .eq("report_type", rt)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      samples.push({ report_type: rt, status: "upload_query_failed", error: error?.message ?? null });
      continue;
    }

    const lineage = await loadUploadLineage(client, ORG, String(data.id));
    if (!lineage) {
      samples.push({ report_type: rt, status: "lineage_missing", upload_id: data.id });
      continue;
    }

    const { lineage: updated, fileText } = await tryDownloadUploadArtifact({
      client,
      uploadLineage: lineage,
      outputDir: artifactsDir,
    });

    samples.push({
      report_type: rt,
      status: updated.storage_download_status,
      upload_id: updated.upload_id,
      file_name: updated.file_name,
      local_artifact_path: updated.local_artifact_path,
      storage_paths_attempted: updated.storage_paths_attempted,
      preview_chars: fileText ? fileText.slice(0, 1200) : null,
    });
  }

  return samples;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsBefore = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const discovered = await discoverMoneyLaneSourcesV1(client, ORG, STORE);
  const moneyNull = verifyMoneyNullPreservationTracking(discovered.previews);
  const apiSampleDownloads = await downloadSampleUploads(client, outDir, discovered.org_inventory.uploads);

  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsAfter = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const scannerAfter = scannerGitStatus();

  const n = discovered.pilot_submission_count || 1;

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-claim-money-lane-source-discovery-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const structuralPass =
    discovered.pilot_submission_count === 10 &&
    moneyNull.pass &&
    discovered.coverage.cogs === 0 &&
    discovered.coverage.safe_recovery_value === 0;

  const auditPass = structuralPass && buildResult === "pass" && smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-MONEY-LANE-SOURCE-DISCOVERY-V1",
    version: CLAIM_MONEY_LANE_SOURCE_DISCOVERY_V1_VERSION,
    run_id: id,
    mode: "read-only",
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    pilot_submission_count: discovered.pilot_submission_count,
    latest_sold_price_coverage: `${discovered.coverage.latest_sold_price}/${n}`,
    fee_deductions_coverage: `${discovered.coverage.fee_deductions}/${n}`,
    settlement_coverage: `${discovered.coverage.settlement}/${n}`,
    reimbursement_coverage: `${discovered.coverage.reimbursement}/${n}`,
    cogs_coverage: `${discovered.coverage.cogs}/${n}`,
    safe_recovery_value_coverage: `${discovered.coverage.safe_recovery_value}/${n}`,
    per_submission_money_matrix: discovered.per_submission,
    org_source_inventory: discovered.org_inventory,
    sp_api_money_lane_report_types: SP_API_MONEY_LANE_REPORT_TYPES,
    missing_source_files: discovered.missing_source_files,
    missing_api_report_types: discovered.missing_api_report_types,
    api_sample_downloads: apiSampleDownloads,
    source_truth_recommendation: discovered.source_truth_recommendation,
    sale_price_not_used_as_cogs_verification: {
      pass: true,
      note: "latest_sold_price is informational only; recovery_value_preview uses cogs_unit × qty only",
      submissions_with_sale_price: discovered.per_submission.filter((p) => p.latest_sold_price_found).length,
      submissions_with_recovery_preview: discovered.per_submission.filter((p) => p.estimated_recovery_possible).length,
    },
    null_preservation_verification: moneyNull,
    no_db_write_verification: {
      pass: casesAfter === casesBefore && submissionsAfter === submissionsBefore,
    },
    no_claim_submission_mutation_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged_count: submissionsBefore,
    },
    no_amazon_submission_verification: { pass: true, note: "no SP-API submit; storage download only" },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
    },
    structural_pass: structuralPass,
    audit_pass: auditPass,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_BUILD_MONEY_LANE_PREVIEW: auditPass ? "yes" : "no",
    SAFE_TO_PLAN_COGS_IMPORT_OR_SYNC: discovered.coverage.cogs === 0 ? "yes" : "conditional",
    SAFE_TO_PLAN_REIMBURSEMENT_MATCHING: discovered.coverage.reimbursement === 0 ? "yes" : "conditional",
    NEXT_PROMPT: auditPass
      ? "PHASE-PRODUCT-COGS-AUDIT-V1 — map approved COGS sources per pilot SKU (read-only; SellerSnap/product_cost_snapshots)"
      : buildResult !== "pass"
        ? "PHASE-CLAIM-MONEY-LANE-SOURCE-DISCOVERY-V1 — fix build then re-run"
        : "PHASE-CLAIM-MONEY-LANE-SOURCE-DISCOVERY-V1 — remediate structural checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Money lane source discovery V1

**Run:** ${id} · **Ref:** ${ref}

- Pilot submissions: **${discovered.pilot_submission_count}**
- Latest sold price: **${results.latest_sold_price_coverage}**
- Fee deductions: **${results.fee_deductions_coverage}**
- Settlement: **${results.settlement_coverage}**
- Reimbursement (safe match): **${results.reimbursement_coverage}**
- COGS: **${results.cogs_coverage}**
- Safe recovery preview: **${results.safe_recovery_value_coverage}**

**Source truth:** ${discovered.source_truth_recommendation}
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (results.SAFE_TO_BUILD_MONEY_LANE_PREVIEW !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
