/**
 * Smoke — claim filing packet UI V1 (static checks)
 *   npx tsx scripts/smoke-claim-filing-packet-ui-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-filing-packet-ui-v1";
const UI_CONTRACT = "lib/claims/filing/claim-filing-packet-ui-contract.ts";
const SECTION = "components/claim-center/case-review/ClaimCaseReviewFilingPacketSection.tsx";
const DRAWER = "components/claim-center/case-review/ClaimCaseReviewDetailDrawer.tsx";
const VIEW = "components/claim-center/case-review/ClaimCaseReviewView.tsx";
const DISABLED = "components/claim-center/case-review/ClaimCaseReviewDisabledActions.tsx";
const CASE_CONTRACT = "lib/claims/pilot/claim-case-review-ui-contract.ts";
const API_ROUTE = "app/api/claims/center/filing-packet-preview/route.ts";

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

  const section = fs.readFileSync(path.join(process.cwd(), SECTION), "utf8");
  const drawer = fs.readFileSync(path.join(process.cwd(), DRAWER), "utf8");
  const view = fs.readFileSync(path.join(process.cwd(), VIEW), "utf8");
  const disabled = fs.readFileSync(path.join(process.cwd(), DISABLED), "utf8");
  const uiContract = fs.readFileSync(path.join(process.cwd(), UI_CONTRACT), "utf8");
  const caseContract = fs.readFileSync(path.join(process.cwd(), CASE_CONTRACT), "utf8");

  const checks = {
    ui_contract_exists: fs.existsSync(path.join(process.cwd(), UI_CONTRACT)),
    section_exists: fs.existsSync(path.join(process.cwd(), SECTION)),
    api_route_exists: fs.existsSync(path.join(process.cwd(), API_ROUTE)),
    drawer_filing_section: drawer.includes("ClaimCaseReviewFilingPacketSection"),
    drawer_filing_packet_fields: drawer.includes("Filing packet") || section.includes("Filing packet"),
    preview_button:
      section.includes("FILING_PACKET_PREVIEW_BUTTON_LABEL") ||
      section.includes("Preview filing packet"),
    readiness_badges: uiContract.includes("ready_for_pdf_preview") && uiContract.includes("needs_review"),
    remediated_disable: section.includes("previewDisabled") && uiContract.includes("isRemediatedDuplicateCase"),
    filing_api_path:
      section.includes("FILING_PACKET_API_PATH") ||
      section.includes("/api/claims/center/filing-packet-preview"),
    view_passes_fetch: view.includes("fetchJson={fetchJson}"),
    case_contract_filing_api: caseContract.includes("filing-packet-preview"),
    drawer_fields_filing: caseContract.includes("filing_packet"),
    disabled_submit:
      disabled.includes("CASE_REVIEW_DISABLED_ACTIONS") && caseContract.includes("submit_claim"),
    disabled_pdf: caseContract.includes("generate_pdf"),
    disabled_create_submission: caseContract.includes("create_submission"),
    disabled_close: caseContract.includes("close_case"),
    disabled_edit: caseContract.includes("edit_case"),
    no_insert: !section.includes(".insert("),
    no_pdf_lib: !section.includes("@react-pdf"),
    no_scanner: !section.includes("operator-mobile"),
    no_ai: !section.includes("openai"),
    no_amazon: !section.includes("amazon-sp-api"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-FILING-PACKET-UI-V1",
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
