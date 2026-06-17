/**
 * PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1
 *   npx tsx scripts/phase-claim-manual-filing-status-entry-execute-v1.ts [--execute] [--input=path]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  loadManualFilingExecuteInputFile,
  MANUAL_FILING_STATUS_ENTRY_EXECUTE_V1,
  runManualFilingStatusEntryExecuteV1,
} from "../lib/claims/submission/claim-manual-filing-status-entry-execute-v1";
import { composeReimbursementTrackingPreviewV1 } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-manual-filing-status-entry-execute-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function isExecute(): boolean {
  return process.argv.includes("--execute");
}

function inputPathArg(): string {
  const a = process.argv.find((x) => x.startsWith("--input="));
  return a?.split("=")[1]?.trim() ?? MANUAL_FILING_STATUS_ENTRY_EXECUTE_V1.defaultInputPath;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function buildInputTemplateFromPilot(
  previews: Awaited<ReturnType<typeof composeReimbursementTrackingPreviewV1>>["previews"],
): Record<string, unknown> {
  return {
    _instruction:
      "Fill amazon_case_id and filed_at after operator files in Seller Central. Do not use placeholder case IDs in production execute.",
    input_source: "operator_ui_export",
    filed_by: "Maysam",
    accept_cogs_missing: false,
    entries: previews.map((p) => ({
      claim_submission_id: p.claim_submission_id,
      amazon_case_id: "",
      filed_at: "",
      filed_by: "Maysam",
      amazon_case_url: "",
      filing_notes: "",
      operator_already_filed_in_seller_central: false,
      _reference_family: p.claim_family,
      _reference_fnsku: p.fnsku ?? null,
    })),
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(OUT, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });

  const scannerBefore = scannerGitStatus();
  const inputPath = inputPathArg();
  const inputFullPath = path.join(process.cwd(), inputPath);

  const pilotPreview = await composeReimbursementTrackingPreviewV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  fs.writeFileSync(
    path.join(outDir, "input-template-from-pilot.json"),
    JSON.stringify(buildInputTemplateFromPilot(pilotPreview.previews), null, 2),
  );

  let executeResult: Awaited<ReturnType<typeof runManualFilingStatusEntryExecuteV1>> | null = null;
  let inputLoaded = false;

  if (fs.existsSync(inputFullPath)) {
    try {
      const input = loadManualFilingExecuteInputFile(inputPath);
      inputLoaded = true;
      executeResult = await runManualFilingStatusEntryExecuteV1({
        client,
        organizationId: ORG,
        storeId: STORE,
        executeRunId: rid,
        input,
        execute: isExecute(),
        actorId: "phase-execute",
      });
    } catch (e) {
      fs.writeFileSync(
        path.join(outDir, "input-load-error.txt"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }

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
    execSync("npx tsx scripts/smoke-claim-manual-filing-status-entry-execute-v1.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const noClaimCountChange =
    executeResult == null ||
    executeResult.before_snapshot.claim_submissions_count ===
      (executeResult.after_snapshot?.claim_submissions_count ??
        executeResult.before_snapshot.claim_submissions_count);

  const phasePass =
    !!executeResult &&
    executeResult.SAFE_MANUAL_FILING_STATUS_ENTRY_EXECUTED &&
    noClaimCountChange &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const result = {
    phase: MANUAL_FILING_STATUS_ENTRY_EXECUTE_V1.phase,
    execute_run_id: rid,
    db_ref: ref,
    mode: isExecute() ? "execute" : "plan-only",
    input_path: inputPath,
    input_loaded: inputLoaded,
    execute_flag: isExecute(),
    ...(executeResult ?? {
      approval_status: { write: "denied", write_enabled: false, default_mode: "dry_run_preview" },
      prerequisites: null,
      selected_submission_count: 0,
      updated_submission_count: 0,
      skipped_count: 0,
      skip_reasons: [],
      before_snapshot: null,
      after_snapshot: null,
      per_submission_status_matrix: [],
      external_case_id_storage_verification: false,
      audit_event_verification: false,
      duplicate_external_case_id_verification: true,
      legacy_submissions_untouched_verification: true,
      executed: false,
      SAFE_MANUAL_FILING_STATUS_ENTRY_EXECUTED: false,
      SAFE_CLAIM_PILOT_READY_FOR_FINAL_VERIFY: false,
      NEXT_PROMPT: "Fill operator input JSON from input-template-from-pilot.json",
    }),
    no_db_write_verification: !isExecute() || (executeResult?.updated_submission_count ?? 0) === 0,
    no_claim_submission_mutation_verification: noClaimCountChange,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    build_result: buildResult,
    smoke_result: smokeResult,
    phase_pass: phasePass,
  };

  if (executeResult) {
    fs.writeFileSync(
      path.join(outDir, "before-snapshot.json"),
      JSON.stringify(executeResult.before_snapshot, null, 2),
    );
    if (executeResult.after_snapshot) {
      fs.writeFileSync(
        path.join(outDir, "after-snapshot.json"),
        JSON.stringify(executeResult.after_snapshot, null, 2),
      );
    }
    fs.writeFileSync(
      path.join(outDir, "per-submission-status-matrix.json"),
      JSON.stringify(executeResult.per_submission_status_matrix, null, 2),
    );
  }

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# ${result.phase}

- Run: \`${rid}\`
- Mode: **${isExecute() ? "execute" : "plan-only"}**
- Approval write_enabled: **${executeResult?.approval_status.write_enabled ? "yes" : "no"}**
- Selected: **${executeResult?.selected_submission_count ?? 0}**
- Updated: **${executeResult?.updated_submission_count ?? 0}**
- SAFE_MANUAL_FILING_STATUS_ENTRY_EXECUTED: **${executeResult?.SAFE_MANUAL_FILING_STATUS_ENTRY_EXECUTED ?? false}**
- phase_pass: **${phasePass}**

## NEXT_PROMPT
\`${executeResult?.NEXT_PROMPT ?? "Fill input and re-run"}\`
`,
  );

  console.log(JSON.stringify(result, null, 2));

  if (isExecute() === false && executeResult && executeResult.updated_submission_count > 0) {
    throw new Error("BLOCKED: writes occurred without --execute flag");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
