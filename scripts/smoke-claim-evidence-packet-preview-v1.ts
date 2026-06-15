/**
 * Smoke — claim evidence packet preview V1 (static checks)
 *   npx tsx scripts/smoke-claim-evidence-packet-preview-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-evidence-packet-preview-v1";
const COMPOSER = "lib/claims/evidence/claim-evidence-packet-v1.ts";
const API_ROUTE = "app/api/claims/center/evidence-packet/route.ts";
const PHASE_SCRIPT = "scripts/phase-claim-evidence-packet-preview-v1.ts";
const PLAN_RESULTS =
  ".cursor/audit-reports/phase-claim-evidence-packet-v1-plan/20260615T080000Z/results.json";

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

  const composer = fs.readFileSync(path.join(process.cwd(), COMPOSER), "utf8");
  const api = fs.readFileSync(path.join(process.cwd(), API_ROUTE), "utf8");
  const phase = fs.readFileSync(path.join(process.cwd(), PHASE_SCRIPT), "utf8");

  const planOk = (() => {
    const p = path.join(process.cwd(), PLAN_RESULTS);
    if (!fs.existsSync(p)) return false;
    return (JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>)
      .SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW === "yes";
  })();

  const checks = {
    plan_prerequisite: planOk,
    composer_exists: fs.existsSync(path.join(process.cwd(), COMPOSER)),
    api_route_exists: fs.existsSync(path.join(process.cwd(), API_ROUTE)),
    api_get_route: api.includes("export async function GET"),
    candidate_id_param: api.includes("candidate_id"),
    intake_run_id_param: api.includes("intake_run_id"),
    readiness_shape: composer.includes("ready_for_case_creation"),
    blocker_flags: composer.includes("blocker_flags"),
    money_lanes: composer.includes("money_lanes"),
    sale_price_display_only: composer.includes("sale_price_display_only"),
    disputed_excluded: composer.includes("disputed_quantity_excluded"),
    no_hard_delete: !/DELETE\s+FROM/i.test(composer),
    no_db_write_phase: !phase.includes(".insert(") && !phase.includes(".update(") && !phase.includes(".delete("),
    no_scanner_import: !composer.includes("operator-mobile"),
    no_ai: !composer.includes("openai") && !composer.includes("gpt"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1",
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
