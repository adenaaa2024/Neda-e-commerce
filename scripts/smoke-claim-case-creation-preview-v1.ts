/**
 * Smoke — claim case creation preview V1 (static checks)
 *   npx tsx scripts/smoke-claim-case-creation-preview-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-case-creation-preview-v1";
const PREVIEW = "lib/claims/case-creation/claim-case-creation-preview-v1.ts";
const PHASE_SCRIPT = "scripts/phase-claim-case-creation-preview-v1.ts";
const CONTRACT = "lib/claims/contracts/claim-case-creation-contract-v1.ts";
const CONTRACT_RESULTS =
  ".cursor/audit-reports/phase-claim-case-creation-contract-v1/20260615T160000Z/results.json";

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

  const preview = fs.readFileSync(path.join(process.cwd(), PREVIEW), "utf8");
  const phase = fs.readFileSync(path.join(process.cwd(), PHASE_SCRIPT), "utf8");
  const contract = fs.readFileSync(path.join(process.cwd(), CONTRACT), "utf8");

  const contractOk = (() => {
    const p = path.join(process.cwd(), CONTRACT_RESULTS);
    if (!fs.existsSync(p)) return false;
    return (JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>)
      .SAFE_TO_BUILD_CASE_CREATION_PREVIEW === "yes";
  })();

  const checks = {
    contract_prerequisite: contractOk,
    preview_exists: fs.existsSync(path.join(process.cwd(), PREVIEW)),
    phase_script_exists: fs.existsSync(path.join(process.cwd(), PHASE_SCRIPT)),
    compose_fn: preview.includes("composeClaimCaseCreationPreviewV1"),
    case_preview_shape: preview.includes("CASE_PREVIEW_SHAPE"),
    recommended_actions: preview.includes("create_case_preview_ready") &&
      preview.includes("needs_operator_review") &&
      preview.includes("blocked"),
    duplicate_risk: preview.includes("duplicate_risk"),
    idempotency_keys:
      preview.includes("buildCaseIdempotencyKey") && preview.includes("buildLineIdempotencyKey"),
    grouping_default: preview.includes("GROUPING_RULES.default_mode"),
    uses_contract_eligibility: preview.includes("evaluateCaseCreationEligibility"),
    uses_evidence_packet: preview.includes("composeClaimEvidencePacketV1"),
    no_db_write_preview: !/\.from\([^)]+\)\s*\.(insert|update|delete)\(/i.test(preview),
    no_db_write_phase: !/\.from\([^)]+\)\s*\.(insert|update|delete)\(/i.test(phase),
    no_pdf: !preview.includes("@react-pdf") && !preview.includes("renderToStream"),
    no_scanner_import: !preview.includes("operator-mobile"),
    no_ai: !preview.includes("openai") && !preview.includes("gpt"),
    contract_import: contract.includes("CLAIM_CASE_CREATION_CONTRACT_VERSION"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-CASE-CREATION-PREVIEW-V1",
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
