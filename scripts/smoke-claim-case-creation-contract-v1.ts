/**
 * Smoke — claim case creation contract V1 (static checks)
 *   npx tsx scripts/smoke-claim-case-creation-contract-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-case-creation-contract-v1";
const CONTRACT = "lib/claims/contracts/claim-case-creation-contract-v1.ts";
const PHASE_SCRIPT = "scripts/phase-claim-case-creation-contract-v1.ts";
const UI_CONTRACT = "lib/claims/pilot/claim-pilot-review-ui-contract.ts";
const VERIFY_RESULTS =
  ".cursor/audit-reports/phase-claim-evidence-packet-preview-v1-verify/20260615T140000Z/results.json";
const UI_RESULTS =
  ".cursor/audit-reports/phase-claim-evidence-packet-ui-v1/20260615T150000Z/results.json";

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

  const contract = fs.readFileSync(path.join(process.cwd(), CONTRACT), "utf8");
  const phase = fs.readFileSync(path.join(process.cwd(), PHASE_SCRIPT), "utf8");
  const ui = fs.readFileSync(path.join(process.cwd(), UI_CONTRACT), "utf8");

  const verifyOk = (() => {
    const p = path.join(process.cwd(), VERIFY_RESULTS);
    if (!fs.existsSync(p)) return false;
    return (JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>)
      .SAFE_EVIDENCE_PACKET_PREVIEW_VERIFIED === "yes";
  })();

  const uiOk = (() => {
    const p = path.join(process.cwd(), UI_RESULTS);
    if (!fs.existsSync(p)) return false;
    return (JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>)
      .SAFE_TO_PLAN_CASE_CREATION_CONTRACT === "yes";
  })();

  const checks = {
    verify_prerequisite: verifyOk,
    ui_prerequisite: uiOk,
    contract_exists: fs.existsSync(path.join(process.cwd(), CONTRACT)),
    phase_script_exists: fs.existsSync(path.join(process.cwd(), PHASE_SCRIPT)),
    eligible_rules: contract.includes("ELIGIBLE_CANDIDATE_RULES"),
    ineligible_rules: contract.includes("INELIGIBLE_CANDIDATE_RULES"),
    evidence_rules: contract.includes("EVIDENCE_RULES"),
    grouping_rules: contract.includes("GROUPING_RULES"),
    case_schema_plan: contract.includes("CASE_SCHEMA_PLAN"),
    duplicate_prevention: contract.includes("DUPLICATE_PREVENTION_CONTRACT"),
    rollback_contract: contract.includes("ROLLBACK_CONTRACT"),
    evaluate_eligibility: contract.includes("evaluateCaseCreationEligibility"),
    idempotency_keys: contract.includes("cc:pool:v1:") && contract.includes("cc:line:candidate:"),
    migration_no: contract.includes('answer: "no"'),
    no_insert_contract: !contract.includes(".insert("),
    no_db_write_phase: !/\.from\([^)]+\)\s*\.(insert|update|delete)\(/i.test(phase),
    create_case_disabled_ui: ui.includes("create_case") || ui.includes("Create case"),
    no_scanner_import: !contract.includes("operator-mobile"),
    no_ai: !contract.includes("openai") && !contract.includes("gpt"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-CASE-CREATION-CONTRACT-V1",
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
