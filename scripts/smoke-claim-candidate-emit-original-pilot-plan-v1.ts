/**
 * Smoke — claim candidate emit original pilot plan V1 (static checks)
 *   npx tsx scripts/smoke-claim-candidate-emit-original-pilot-plan-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-candidate-emit-original-pilot-plan-v1";
const PHASE = "scripts/phase-claim-candidate-emit-original-pilot-plan-v1.ts";
const APPROVAL = ".cursor/operator-approvals/claim-candidate-emit-original-pilot-v1-approval.md";

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
  const src = fs.readFileSync(path.join(process.cwd(), PHASE), "utf8");
  const body = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  const checks = {
    phase_script_exists: fs.existsSync(path.join(process.cwd(), PHASE)),
    approval_template_exists: fs.existsSync(path.join(process.cwd(), APPROVAL)),
    original_ref_guard: src.includes("PRODUCTION_REF"),
    staging_ref_blocked: src.includes("STAGING_REF") && src.includes("BLOCKED"),
    read_only_mode: src.includes("READ_ONLY_PLAN") && src.includes("planning only"),
    no_db_writes:
      !/\.(insert|update|delete|upsert)\s*\(/i.test(body) && src.includes("READ_ONLY_PLAN"),
    preview_generators_wired: src.includes("buildFirstSafeFamiliesPreviewGenerators"),
    rollback_quarantine_only: src.includes("quarantine_supersede"),
    approved_families: src.includes("removal_order_discrepancy") && src.includes("removal_shipment_missing"),
    execute_prompt_defined: src.includes("PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-V1"),
    no_scanner_import: !src.includes("operator-mobile"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-PLAN-V1",
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
