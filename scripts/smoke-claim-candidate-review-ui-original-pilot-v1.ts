/**
 * Smoke — claim candidate review UI original pilot V1 (static checks)
 *   npx tsx scripts/smoke-claim-candidate-review-ui-original-pilot-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-candidate-review-ui-original-pilot-v1";
const PHASE_SCRIPT = "scripts/phase-claim-candidate-review-ui-original-pilot-v1.ts";
const ROUTE_PAGE = "app/claim-center/pilot-review/page.tsx";
const API_ROUTE = "app/api/claims/center/pilot-review/route.ts";
const VIEW = "components/claim-center/pilot/ClaimPilotReviewView.tsx";
const READMODEL = "lib/claims/pilot/claim-pilot-review-readmodel.ts";
const UI_CONTRACT = "lib/claims/pilot/claim-pilot-review-ui-contract.ts";
const RESTORE_RESULTS =
  ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-restore-for-review-v1/20260615T060000Z/results.json";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readFile(rel: string): string {
  const p = path.join(process.cwd(), rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const viewSrc = readFile(VIEW);
  const contractSrc = readFile(UI_CONTRACT);
  const readmodelSrc = readFile(READMODEL);
  const phaseSrc = readFile(PHASE_SCRIPT);

  const restoreOk = (() => {
    const p = path.join(process.cwd(), RESTORE_RESULTS);
    if (!fs.existsSync(p)) return false;
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;
    return j.SAFE_ORIGINAL_PILOT_RESTORED_FOR_REVIEW === "yes";
  })();

  const checks = {
    restore_prerequisite: restoreOk,
    route_page_exists: fs.existsSync(path.join(process.cwd(), ROUTE_PAGE)),
    api_route_exists: fs.existsSync(path.join(process.cwd(), API_ROUTE)),
    view_exists: fs.existsSync(path.join(process.cwd(), VIEW)),
    readmodel_exists: fs.existsSync(path.join(process.cwd(), READMODEL)),
    ui_contract_exists: fs.existsSync(path.join(process.cwd(), UI_CONTRACT)),
    phase_script_exists: fs.existsSync(path.join(process.cwd(), PHASE_SCRIPT)),
    route_pilot_review: viewSrc.includes("/claim-center/pilot-review"),
    api_pilot_review:
      readFile(API_ROUTE).includes("pilot-review") ||
      readFile(API_ROUTE).includes("getCenterPilotReviewPayload"),
    intake_run_id_filter: contractSrc.includes("intake_run_id"),
    family_filter: contractSrc.includes("family_key_v3"),
    summary_cards: fs.existsSync(path.join(process.cwd(), "components/claim-center/pilot/ClaimPilotReviewSummary.tsx")),
    detail_drawer: fs.existsSync(path.join(process.cwd(), "components/claim-center/pilot/ClaimPilotReviewDetailDrawer.tsx")),
    disabled_actions: viewSrc.includes("ClaimPilotReviewDisabledActions"),
    no_hard_delete: !readmodelSrc.includes(".delete(") && !/DELETE\s+FROM/i.test(readmodelSrc),
    no_scanner_import: !viewSrc.includes("operator-mobile"),
    read_only_flag: readmodelSrc.includes("read_only: true"),
    disabled_approve_reject: contractSrc.includes('"approve"') && contractSrc.includes('"reject"'),
    nav_entry: readFile("components/claim-center/claim-center-nav-config.ts").includes("pilot-review"),
    no_write_in_phase: !phaseSrc.includes(".update(") && !phaseSrc.includes(".insert("),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-CANDIDATE-REVIEW-UI-ORIGINAL-PILOT-V1",
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
