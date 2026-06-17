/**
 * Smoke — claim case creation preview UI V1 (static checks)
 *   npx tsx scripts/smoke-claim-case-creation-preview-ui-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-case-creation-preview-ui-v1";
const UI_CONTRACT = "lib/claims/pilot/claim-case-creation-preview-ui-contract.ts";
const CASE_SECTION = "components/claim-center/pilot/ClaimPilotReviewCasePreviewSection.tsx";
const BULK_PANEL = "components/claim-center/pilot/ClaimPilotReviewBulkCasePreviewPanel.tsx";
const DRAWER = "components/claim-center/pilot/ClaimPilotReviewDetailDrawer.tsx";
const VIEW = "components/claim-center/pilot/ClaimPilotReviewView.tsx";
const API_ROUTE = "app/api/claims/center/case-creation-preview/route.ts";
const PREVIEW_RESULTS =
  ".cursor/audit-reports/phase-claim-case-creation-preview-v1/20260615T170000Z/results.json";

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
  const caseSection = fs.readFileSync(path.join(process.cwd(), CASE_SECTION), "utf8");
  const bulkPanel = fs.readFileSync(path.join(process.cwd(), BULK_PANEL), "utf8");
  const drawer = fs.readFileSync(path.join(process.cwd(), DRAWER), "utf8");
  const view = fs.readFileSync(path.join(process.cwd(), VIEW), "utf8");
  const api = fs.readFileSync(path.join(process.cwd(), API_ROUTE), "utf8");

  const previewOk = (() => {
    const p = path.join(process.cwd(), PREVIEW_RESULTS);
    if (!fs.existsSync(p)) return false;
    const r = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;
    return (
      r.SAFE_CASE_CREATION_PREVIEW_READY === "yes" && r.SAFE_TO_PLAN_CASE_CREATION_PILOT === "yes"
    );
  })();

  const CASE_PREVIEW_BUTTON_LABEL = "Preview case creation";

  const checks = {
    preview_prerequisite: previewOk,
    ui_contract_exists: fs.existsSync(path.join(process.cwd(), UI_CONTRACT)),
    api_route_exists: fs.existsSync(path.join(process.cwd(), API_ROUTE)),
    api_get_route: api.includes("export async function GET"),
    candidate_id_param: api.includes("candidate_id"),
    candidate_ids_param: api.includes("candidate_ids"),
    case_preview_section: drawer.includes("ClaimPilotReviewCasePreviewSection"),
    bulk_panel: view.includes("ClaimPilotReviewBulkCasePreviewPanel"),
    preview_button: caseSection.includes(CASE_PREVIEW_BUTTON_LABEL),
    bulk_modes: bulkPanel.includes("all_pilot") && bulkPanel.includes("selected") && bulkPanel.includes("grouped"),
    evidence_link: caseSection.includes("EVIDENCE_PACKET_SECTION_ID"),
    recommended_action_display: caseSection.includes("recommended_action"),
    duplicate_risk_display: caseSection.includes("duplicate_risk"),
    read_only_label: caseSection.includes("read-only"),
    no_insert_ui: !caseSection.includes(".insert("),
    no_pdf: !caseSection.includes("@react-pdf"),
    no_scanner: !caseSection.includes("operator-mobile"),
    no_ai: !caseSection.includes("openai"),
    contract_api_path: contract.includes("/api/claims/center/case-creation-preview"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-CASE-CREATION-PREVIEW-UI-V1",
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
