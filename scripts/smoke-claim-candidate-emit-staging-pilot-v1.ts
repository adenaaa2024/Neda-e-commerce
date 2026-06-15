/**
 * Smoke — claim candidate emit staging pilot V1 (static + optional staging read)
 *   npx tsx scripts/smoke-claim-candidate-emit-staging-pilot-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { readPilotApprovalStatus } from "../lib/claims/intake/claim-preview-emit-v1";

const OUT = ".cursor/audit-reports/smoke-claim-candidate-emit-staging-pilot-v1";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const emitSrc = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/intake/claim-preview-emit-v1.ts"),
    "utf8",
  );
  const approval = readPilotApprovalStatus();

  const checks = {
    emit_module_exists: fs.existsSync(
      path.join(process.cwd(), "lib/claims/intake/claim-preview-emit-v1.ts"),
    ),
    phase_script_exists: fs.existsSync(
      path.join(process.cwd(), "scripts/phase-claim-candidate-emit-staging-pilot-v1.ts"),
    ),
    approval_file_exists: fs.existsSync(
      path.join(
        process.cwd(),
        ".cursor/operator-approvals/claim-candidate-emit-staging-pilot-v1-approval.md",
      ),
    ),
    approval_signed: approval.approved,
    uses_apply_drafts: emitSrc.includes("applyDrafts"),
    emit_origin_tag: emitSrc.includes("preview_emit_v1"),
    max_rows_cap: emitSrc.includes("DEFAULT_PILOT_MAX_ROWS = 50"),
    no_hard_delete_rollback: emitSrc.includes("quarantine") && !emitSrc.includes(".delete("),
    staging_ref_guard: emitSrc.includes("eiqfaapyumhixxoeltgu"),
    date_gate_module: fs.existsSync(
      path.join(process.cwd(), "lib/claims/intake/claim-preview-emit-date-gate-v1.ts"),
    ),
    date_gate_wired: emitSrc.includes("evaluateClaimPreviewEmitDateGate"),
    date_gate_metadata: emitSrc.includes("date_gate_passed"),
    effective_date_config_required: emitSrc.includes("claim_start_date and scan_go_live_date must be configured"),
    no_scanner_import: !emitSrc.includes("operator-mobile"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-V1",
    run_id: id,
    checks,
    pass: failures.length === 0,
    smoke_result: failures.length === 0 ? "PASS" : "FAIL",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));

  if (failures.length) {
    console.error("FAIL:", failures.join(", "));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, run_id: id, smoke: "PASS" }));
}

main();
