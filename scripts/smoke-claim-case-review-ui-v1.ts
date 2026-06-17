/**
 * Smoke — claim case review UI V1 (static checks)
 *   npx tsx scripts/smoke-claim-case-review-ui-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-case-review-ui-v1";
const UI_CONTRACT = "lib/claims/pilot/claim-case-review-ui-contract.ts";
const READMODEL = "lib/claims/pilot/claim-case-review-readmodel.ts";
const VIEW = "components/claim-center/case-review/ClaimCaseReviewView.tsx";
const DRAWER = "components/claim-center/case-review/ClaimCaseReviewDetailDrawer.tsx";
const DISABLED = "components/claim-center/case-review/ClaimCaseReviewDisabledActions.tsx";
const API_ROUTE = "app/api/claims/center/case-review/route.ts";
const PAGE = "app/claim-center/case-review/page.tsx";

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

  const contract = fs.readFileSync(path.join(process.cwd(), UI_CONTRACT), "utf8");
  const view = fs.readFileSync(path.join(process.cwd(), VIEW), "utf8");
  const drawer = fs.readFileSync(path.join(process.cwd(), DRAWER), "utf8");
  const disabled = fs.readFileSync(path.join(process.cwd(), DISABLED), "utf8");
  const api = fs.readFileSync(path.join(process.cwd(), API_ROUTE), "utf8");

  const checks = {
    ui_contract_exists: fs.existsSync(path.join(process.cwd(), UI_CONTRACT)),
    readmodel_exists: fs.existsSync(path.join(process.cwd(), READMODEL)),
    api_route_exists: fs.existsSync(path.join(process.cwd(), API_ROUTE)),
    page_exists: fs.existsSync(path.join(process.cwd(), PAGE)),
    api_get_route: api.includes("export async function GET"),
    pilot_case_run_id_param: api.includes("pilot_case_run_id"),
    case_review_route: view.includes("/api/claims/center/case-review"),
    drawer_packet_snapshot: drawer.includes("Evidence packet snapshot"),
    drawer_attestation: drawer.includes("Operator attestation"),
    drawer_candidate_link: drawer.includes("Candidate link"),
    disabled_submit: disabled.includes("CASE_REVIEW_DISABLED_ACTIONS"),
    disabled_pdf: contract.includes("generate_pdf"),
    disabled_close: contract.includes("close_case"),
    disabled_edit: contract.includes("edit_case"),
    read_only_label: view.includes("read-only"),
    no_insert_ui: !view.includes(".insert("),
    no_pdf: !view.includes("@react-pdf"),
    no_scanner: !view.includes("operator-mobile"),
    no_ai: !view.includes("openai"),
    contract_api_path: contract.includes("/api/claims/center/case-review"),
    nav_case_review: fs
      .readFileSync(path.join(process.cwd(), "components/claim-center/claim-center-nav-config.ts"), "utf8")
      .includes("/claim-center/case-review"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-CASE-REVIEW-UI-V1",
    run_id: id,
    checks,
    failures,
    smoke_result: failures.length === 0 ? "pass" : "fail",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

main();
