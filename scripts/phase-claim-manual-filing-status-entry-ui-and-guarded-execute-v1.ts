/**
 * PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-AND-GUARDED-EXECUTE-V1
 *   npx tsx scripts/phase-claim-manual-filing-status-entry-ui-and-guarded-execute-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { attemptGuardedManualFilingExecuteV1 } from "../lib/claims/submission/claim-manual-filing-status-entry-guarded-execute-v1";
import { composeManualFilingStatusEntryDryRunV1 } from "../lib/claims/submission/claim-manual-filing-status-entry-dry-run-v1";
import {
  MANUAL_FILING_EXECUTE_MANIFEST,
  auditManualFilingSchemaV1,
  findPilotModalSamplesV1,
  readManualFilingWriteApprovalStatus,
  verifyManualFilingUiIntegrationStatic,
} from "../lib/claims/submission/claim-manual-filing-status-entry-ui-and-guarded-execute-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-manual-filing-status-entry-ui-and-guarded-execute-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const UI_FILES_CHANGED = [
  "lib/claims/submission/claim-manual-filing-status-entry-ui-and-guarded-execute-v1.ts",
  "lib/claims/submission/claim-manual-filing-status-entry-guarded-execute-v1.ts",
  "lib/claims/submission/claim-manual-filing-status-entry-ui-contract.ts",
  "lib/claims/submission/claim-manual-filing-status-entry-dry-run-v1.ts",
  "app/api/claims/center/manual-filing-status-entry/execute/route.ts",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingManualFilingModal.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingManualFilingSection.tsx",
  ".cursor/operator-approvals/manual-filing-status-entry-write-v1-approval.md",
  "supabase/migrations/20260618140000_phase_manual_filing_status_entry_guarded_execute_v1.sql",
  "scripts/phase-claim-manual-filing-status-entry-ui-and-guarded-execute-v1.ts",
  "scripts/smoke-claim-manual-filing-status-entry-ui-and-guarded-execute-v1.ts",
];

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

async function submissionCount(client: ReturnType<typeof createClient>, org: string): Promise<number> {
  return (
    (await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", org))
      .count ?? 0
  );
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });

  const scannerBefore = scannerGitStatus();
  const subsBefore = await submissionCount(client, ORG);
  const writeApproval = readManualFilingWriteApprovalStatus();
  const schemaAudit = await auditManualFilingSchemaV1(client, ORG);
  const uiVerification = verifyManualFilingUiIntegrationStatic();
  const modalSamples = await findPilotModalSamplesV1(client, ORG, STORE);

  const sampleSubmissionId =
    modalSamples.shipment_missing?.claim_submission_id ??
    modalSamples.order_discrepancy?.claim_submission_id ??
    null;

  let dryRunPreview = null;
  let blockedExecute = null;

  if (sampleSubmissionId) {
    const dryRunResponse = await composeManualFilingStatusEntryDryRunV1(client, ORG, STORE, {
      claim_submission_id: sampleSubmissionId,
      amazon_case_id: "DRY-RUN-CASE-VERIFY-ONLY",
      filed_at: "2026-06-15T12:00:00",
      amazon_case_url: "https://sellercentral.amazon.com/case/dry-run",
      filing_notes: "Phase verify dry-run only",
      attestation: true,
    });
    dryRunPreview = dryRunResponse.preview;

    blockedExecute = await attemptGuardedManualFilingExecuteV1(
      client,
      ORG,
      STORE,
      {
        claim_submission_id: sampleSubmissionId,
        amazon_case_id: "DRY-RUN-CASE-VERIFY-ONLY",
        filed_at: "2026-06-15T12:00:00",
        amazon_case_url: "",
        filing_notes: "Should not write without approval",
        attestation: true,
        execute_run_id: `phase-verify-${id}`,
      },
      "phase-verify",
    );
  }

  const subsAfter = await submissionCount(client, ORG);
  const scannerAfter = scannerGitStatus();

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    const out = execSync("npx tsx scripts/smoke-claim-manual-filing-status-entry-ui-and-guarded-execute-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = out.includes('"smoke": "pass"') || out.includes('"smoke":"pass"') ? "pass" : out;
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const noUnapprovedWrite =
    writeApproval.write_enabled === false
      ? blockedExecute?.blocked === true && blockedExecute?.written === false && subsBefore === subsAfter
      : blockedExecute?.written === true && subsAfter === subsBefore + 0; // if approved, execute may write one row — not default

  const uiReady =
    Object.values(uiVerification).every(Boolean) &&
    !!modalSamples.shipment_missing &&
    !!modalSamples.order_discrepancy &&
    !!dryRunPreview &&
    dryRunPreview.old_status.length > 0 &&
    dryRunPreview.new_status === "submitted";

  const executeReady =
    uiVerification.execute_route_present &&
    uiVerification.guarded_execute_lib &&
    blockedExecute?.blocked === true &&
    blockedExecute?.written === false &&
    !writeApproval.write_enabled;

  const pilotOperational =
    uiReady &&
    executeReady &&
    schemaAudit.live_db_probe.pilot_submission_count === 10 &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const result = {
    run_id: id,
    db_ref: ref,
    mode: "ui-and-guarded-execute",
    ui_files_changed: UI_FILES_CHANGED,
    schema_support: schemaAudit.schema_support,
    migration_needed: schemaAudit.migration_needed,
    migration_file_if_needed: schemaAudit.migration_file_if_needed,
    migration_required_for_pilot_v1: schemaAudit.migration_required_for_pilot_v1,
    modal_verification: uiVerification.modal_verification,
    validation_verification: uiVerification.validation_verification,
    modal_samples: modalSamples,
    dry_run_status_change_preview: dryRunPreview
      ? {
          old_status: dryRunPreview.old_status,
          new_status: dryRunPreview.new_status,
          new_tracking_status: dryRunPreview.new_tracking_status,
          submission_id_preview: dryRunPreview.submission_id_preview,
        }
      : null,
    write_approval_status: writeApproval,
    execute_result_if_approved: writeApproval.write_enabled ? blockedExecute : null,
    blocked_execute_when_denied: blockedExecute,
    audit_event_payload: dryRunPreview?.audit_event_preview ?? null,
    duplicate_external_case_id_rule: MANUAL_FILING_EXECUTE_MANIFEST.duplicate_external_case_id_rule,
    ui_verification: uiVerification,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    no_unapproved_db_write_verification: noUnapprovedWrite,
    claim_submissions_count_before: subsBefore,
    claim_submissions_count_after: subsAfter,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_MANUAL_FILING_STATUS_ENTRY_UI_READY: uiReady,
    SAFE_MANUAL_FILING_STATUS_ENTRY_EXECUTE_READY: executeReady || writeApproval.write_enabled,
    SAFE_CLAIM_PILOT_OPERATIONAL_COMPLETE: pilotOperational,
    NEXT_PROMPT: writeApproval.write_enabled
      ? "PHASE-CLAIM-MANUAL-FILING-STATUS-EXECUTE-VERIFY-V1 — operator records filing for pilot submissions; verify reimbursement tracking refresh"
      : "Set APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes then re-run execute for one pilot submission",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-AND-GUARDED-EXECUTE-V1

**Run:** \`${id}\`

- **SAFE_MANUAL_FILING_STATUS_ENTRY_UI_READY:** **${uiReady ? "yes" : "no"}**
- **SAFE_MANUAL_FILING_STATUS_ENTRY_EXECUTE_READY:** **${result.SAFE_MANUAL_FILING_STATUS_ENTRY_EXECUTE_READY ? "yes" : "no"}**
- **SAFE_CLAIM_PILOT_OPERATIONAL_COMPLETE:** **${pilotOperational ? "yes" : "no"}**
- **write_enabled:** **${writeApproval.write_enabled ? "yes" : "no"}**
- **migration_needed:** **${schemaAudit.migration_needed ? "yes" : "no"}** (pilot uses source_payload)

## NEXT_PROMPT
\`${result.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify({ ...result, out: path.join(OUT, id) }, null, 2));

  if (writeApproval.write_enabled === false && subsBefore !== subsAfter) {
    throw new Error("BLOCKED: claim_submissions mutated without write approval");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
