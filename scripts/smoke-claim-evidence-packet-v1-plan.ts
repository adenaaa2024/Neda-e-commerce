/**
 * Smoke — claim evidence packet V1 plan (static checks only)
 *   npx tsx scripts/smoke-claim-evidence-packet-v1-plan.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-evidence-packet-v1-plan";
const PLAN_CONTRACT = "lib/claims/evidence/claim-evidence-packet-v1-plan-contract.ts";
const PHASE_SCRIPT = "scripts/phase-claim-evidence-packet-v1-plan.ts";

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

  const plan = fs.readFileSync(path.join(process.cwd(), PLAN_CONTRACT), "utf8");
  const phase = fs.readFileSync(path.join(process.cwd(), PHASE_SCRIPT), "utf8");
  const composer = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/evidence/claim-evidence-packet-composer.ts"),
    "utf8",
  );

  const checks = {
    plan_contract_exists: fs.existsSync(path.join(process.cwd(), PLAN_CONTRACT)),
    phase_script_exists: fs.existsSync(path.join(process.cwd(), PHASE_SCRIPT)),
    composer_reuse_documented: plan.includes("composeClaimEvidencePacket"),
    packet_schema_proposal: plan.includes("ClaimEvidencePacketV1Preview"),
    api_plan_endpoint: plan.includes("evidence-packet/preview"),
    blocker_rules: plan.includes("keeps_evidence_status_missing"),
    money_null_rule: plan.includes("null_preservation"),
    pdf_deferred: plan.includes("pdf_generation_deferred: true"),
    no_db_write_phase: !phase.includes(".insert(") && !phase.includes(".update(") && !phase.includes(".delete("),
    no_hard_delete_composer: !/DELETE\s+FROM/i.test(composer),
    pilot_intake_run_id: plan.includes("a8a892fe-37d5-4d74-9ea2-02af8fd095ce"),
    original_ref: plan.includes("kxsvedvpjldygtdbylsy"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-EVIDENCE-PACKET-V1-PLAN",
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
