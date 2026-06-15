/**
 * Smoke — claim candidate emit original rollback drill V1 (static checks)
 *   npx tsx scripts/smoke-claim-candidate-emit-original-rollback-drill-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-candidate-emit-original-rollback-drill-v1";
const APPROVAL = ".cursor/operator-approvals/claim-candidate-emit-original-rollback-drill-v1-approval.md";
const PHASE_SCRIPT = "scripts/phase-claim-candidate-emit-original-rollback-drill-v1.ts";
const PILOT_ROLLBACK =
  ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-v1/20260614T233000Z/rollback.sql";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): boolean {
  const p = path.join(process.cwd(), APPROVAL);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return /APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_ROLLBACK_DRILL_V1\s*=\s*yes/i.test(text);
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const phaseSrc = fs.readFileSync(path.join(process.cwd(), PHASE_SCRIPT), "utf8");
  const rollbackSql = fs.existsSync(path.join(process.cwd(), PILOT_ROLLBACK))
    ? fs.readFileSync(path.join(process.cwd(), PILOT_ROLLBACK), "utf8")
    : "";

  const rollbackSqlBody = rollbackSql.replace(/--[^\n]*/g, "");
  const checks = {
    approval_file_exists: fs.existsSync(path.join(process.cwd(), APPROVAL)),
    approval_signed: readApproval(),
    phase_script_exists: fs.existsSync(path.join(process.cwd(), PHASE_SCRIPT)),
    pilot_rollback_sql_exists: fs.existsSync(path.join(process.cwd(), PILOT_ROLLBACK)),
    no_hard_delete: !phaseSrc.includes(".delete(") && !/DELETE\s+FROM/i.test(phaseSrc),
    quarantine_only: phaseSrc.includes("quarantined_at") && phaseSrc.includes("superseded"),
    scoped_by_intake_run_id: phaseSrc.includes("intake_run_id") && phaseSrc.includes("emit_origin"),
    target_intake_run_id: phaseSrc.includes("a8a892fe-37d5-4d74-9ea2-02af8fd095ce"),
    original_ref_guard: phaseSrc.includes("kxsvedvpjldygtdbylsy") || phaseSrc.includes("PRODUCTION_REF"),
    blocks_staging: phaseSrc.includes("bindProductionSupabaseEnv"),
    rollback_sql_quarantine:
      rollbackSql.includes("quarantined_at") && !/DELETE\s+FROM/i.test(rollbackSqlBody),
    no_scanner_import: !phaseSrc.includes("operator-mobile"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-ROLLBACK-DRILL-V1",
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
