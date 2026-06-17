/**
 * Smoke — claim case creation pilot V1 (static checks)
 *   npx tsx scripts/smoke-claim-case-creation-pilot-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-case-creation-pilot-v1";
const PILOT = "lib/claims/case-creation/claim-case-creation-pilot-v1.ts";
const PHASE = "scripts/phase-claim-case-creation-pilot-v1.ts";
const APPROVAL = ".cursor/operator-approvals/claim-case-creation-pilot-v1-approval.md";
const PREVIEW_UI =
  ".cursor/audit-reports/phase-claim-case-creation-preview-ui-v1/20260615T180000Z/results.json";

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

  const pilot = fs.readFileSync(path.join(process.cwd(), PILOT), "utf8");
  const phase = fs.readFileSync(path.join(process.cwd(), PHASE), "utf8");

  const uiOk = (() => {
    const p = path.join(process.cwd(), PREVIEW_UI);
    if (!fs.existsSync(p)) return false;
    return (JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>)
      .SAFE_TO_BUILD_CASE_CREATION_PILOT === "yes";
  })();

  const checks = {
    ui_prerequisite: uiOk,
    approval_file_exists: fs.existsSync(path.join(process.cwd(), APPROVAL)),
    pilot_module_exists: fs.existsSync(path.join(process.cwd(), PILOT)),
    execute_fn: pilot.includes("executeClaimCaseCreationPilotV1"),
    rollback_sql: pilot.includes("buildCaseCreationPilotRollbackSql"),
    operator_attestation: pilot.includes("operator_review_attested"),
    idempotency_pool: pilot.includes("buildCaseIdempotencyKey") || pilot.includes("case_idempotency_key"),
    line_idempotency: pilot.includes("buildLineIdempotencyKey"),
    case_creation_origin: pilot.includes("case_creation_pilot_v1"),
    no_submissions_insert: !pilot.includes('from("claim_submissions").insert'),
    no_pdf: !pilot.includes("@react-pdf"),
    no_scanner: !pilot.includes("operator-mobile"),
    phase_script_exists: fs.existsSync(path.join(process.cwd(), PHASE)),
    original_ref_guard: phase.includes("PRODUCTION_REF"),
    dry_run_flag: phase.includes("--dry-run"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-CASE-CREATION-PILOT-V1",
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
