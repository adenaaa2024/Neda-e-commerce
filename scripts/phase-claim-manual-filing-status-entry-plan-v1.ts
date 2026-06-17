/**
 * PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-PLAN-V1 — planning contract only
 *   npx tsx scripts/phase-claim-manual-filing-status-entry-plan-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildManualFilingStatusEntryPlanV1,
  CLAIM_MANUAL_FILING_STATUS_ENTRY_PLAN_V1_VERSION,
  PLAN_MANIFEST,
  PLAN_PREREQUISITES,
  probeClaimSubmissionsSchemaLive,
  snapshotPilotSubmissions,
} from "../lib/claims/submission/claim-manual-filing-status-entry-plan-v1";
import { bindProductionSupabaseEnv } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-manual-filing-status-entry-plan-v1";
const ORG = "00000000-0000-0000-0000-000000000001";

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
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function hasEvidenceRun(baseRel: string): boolean {
  const dir = path.join(process.cwd(), baseRel);
  if (fs.existsSync(dir)) return true;
  const parent = path.dirname(dir);
  const leaf = baseRel.split("/").pop() ?? "";
  if (!fs.existsSync(parent)) return false;
  const prefix = leaf.split("-").slice(0, 3).join("-");
  return fs.readdirSync(parent).some((n) => n.includes(prefix));
}

function prereqChecks(): Record<string, boolean> {
  const evidence: Array<[keyof typeof PLAN_PREREQUISITES, string]> = [
    ["submission_record_pilot_pass", ".cursor/audit-reports/phase-claim-submission-record-pilot-execute-v1"],
    ["reimbursement_tracking_preview_pass", ".cursor/audit-reports/phase-claim-reimbursement-tracking-preview-v1/20260617T130000Z"],
    ["reimbursement_tracking_ui_visible", ".cursor/audit-reports/phase-claim-reimbursement-tracking-ui-main-visibility-repair-v2"],
    ["reimbursement_tracking_nav_dedup_pass", ".cursor/audit-reports/phase-claim-reimbursement-tracking-nav-dedup-ux-polish-v1/20260617T210000Z"],
    ["money_lane_source_discovery_pass", ".cursor/audit-reports/phase-claim-money-lane-source-discovery-v1/20260617T190000Z"],
    ["product_cogs_audit_pass", ".cursor/audit-reports/phase-product-cogs-audit-v1/20260616T231548Z"],
    ["money_lane_preview_pass", ".cursor/audit-reports/phase-claim-money-lane-preview-v1/20260617T230000Z"],
    ["trid_graph_materialized", ".cursor/audit-reports/phase7h-claim-reference-edge-materialization-pilot-original-execute"],
  ];

  const checks = {} as Record<keyof typeof PLAN_PREREQUISITES, boolean>;
  for (const [key, base] of evidence) {
    checks[key] = hasEvidenceRun(base);
  }
  return checks;
}

function buildSummary(result: ReturnType<typeof buildManualFilingStatusEntryPlanV1>, id: string): string {
  return `# PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-PLAN-V1

**Run:** \`${id}\` · **Version:** \`${CLAIM_MANUAL_FILING_STATUS_ENTRY_PLAN_V1_VERSION}\`

## Verdict
- **SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI:** **${result.SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI ? "yes" : "no"}**
- **SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY_EXECUTE:** **${result.SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY_EXECUTE ? "yes" : "no"}**
- **migration_needed:** **${result.migration_needed ? "yes" : "no"}** (pilot V1 can use \`submission_id\` + \`source_payload\`)

## Schema
- **Supported now:** external_case_id → \`submission_id\`, status → enum, metadata → \`source_payload\`
- **Missing (V1 via source_payload):** external_case_url, external_platform, filed_at, filed_by, filing_notes, status_reason

## Pilot snapshot
\`\`\`json
${JSON.stringify(result.pilot_submission_snapshot, null, 2)}
\`\`\`

## Workflow
${result.manual_filing_workflow.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## NEXT_PROMPT
\`${result.NEXT_PROMPT}\`
`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const scannerBefore = scannerGitStatus();
  const { ref, url } = bindProductionSupabaseEnv();
  const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });

  const subsBefore =
    (await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
      .count ?? 0;

  const liveProbe = await probeClaimSubmissionsSchemaLive(client, ORG);
  const pilotSnapshot = await snapshotPilotSubmissions(client, ORG);

  const subsAfter =
    (await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
      .count ?? 0;

  const scannerAfter = scannerGitStatus();
  const prerequisites = prereqChecks();

  const plan = buildManualFilingStatusEntryPlanV1({
    liveDbProbe: liveProbe,
    pilotSnapshot,
    prerequisites,
    submissionsCountBefore: subsBefore,
    submissionsCountAfter: subsAfter,
    scannerUnchanged: scannerBefore === scannerAfter,
  });

  const payload = {
    run_id: id,
    db_ref: ref,
    organization_id: ORG,
    plan_manifest: PLAN_MANIFEST,
    prerequisites,
    scanner_before: scannerBefore,
    scanner_after: scannerAfter,
    claim_submissions_count: { before: subsBefore, after: subsAfter },
    ...plan,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "summary.md"), buildSummary(plan, id));

  console.log(
    JSON.stringify(
      {
        run_id: id,
        migration_needed: plan.migration_needed,
        pilot_count: pilotSnapshot.pilot_count,
        SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI: plan.SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI,
        SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY_EXECUTE: plan.SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY_EXECUTE,
        NEXT_PROMPT: plan.NEXT_PROMPT,
        out: path.join(OUT, id),
      },
      null,
      2,
    ),
  );

  if (!plan.no_claim_submission_mutation_verification) {
    throw new Error("BLOCKED: claim_submissions count changed during read-only plan phase");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
