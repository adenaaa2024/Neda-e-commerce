/**
 * Smoke — claim evidence packet UI V1 (static checks)
 *   npx tsx scripts/smoke-claim-evidence-packet-ui-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-evidence-packet-ui-v1";
const PREVIEW_RESULTS =
  ".cursor/audit-reports/phase-claim-evidence-packet-preview-v1/20260615T091500Z/results.json";
const UI_CONTRACT = "lib/claims/pilot/claim-evidence-packet-ui-contract.ts";
const PILOT_UI_CONTRACT = "lib/claims/pilot/claim-pilot-review-ui-contract.ts";
const SECTION = "components/claim-center/pilot/ClaimPilotReviewEvidencePacketSection.tsx";
const DRAWER = "components/claim-center/pilot/ClaimPilotReviewDetailDrawer.tsx";
const VIEW = "components/claim-center/pilot/ClaimPilotReviewView.tsx";
const API_ROUTE = "app/api/claims/center/evidence-packet/route.ts";
const PHASE_SCRIPT = "scripts/phase-claim-evidence-packet-ui-v1.ts";

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

  const sectionSrc = readFile(SECTION);
  const drawerSrc = readFile(DRAWER);
  const viewSrc = readFile(VIEW);
  const uiContractSrc = readFile(UI_CONTRACT);
  const pilotContractSrc = readFile(PILOT_UI_CONTRACT);
  const phaseSrc = readFile(PHASE_SCRIPT);

  const previewOk = (() => {
    const p = path.join(process.cwd(), PREVIEW_RESULTS);
    if (!fs.existsSync(p)) return false;
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;
    return (
      j.SAFE_EVIDENCE_PACKET_PREVIEW_READY === "yes" &&
      j.SAFE_TO_BUILD_EVIDENCE_PACKET_UI === "yes"
    );
  })();

  const checks = {
    preview_prerequisite: previewOk,
    ui_contract_exists: fs.existsSync(path.join(process.cwd(), UI_CONTRACT)),
    section_component_exists: fs.existsSync(path.join(process.cwd(), SECTION)),
    drawer_wires_section: drawerSrc.includes("ClaimPilotReviewEvidencePacketSection"),
    view_passes_fetch_json: viewSrc.includes("fetchJson={fetchJson}"),
    evidence_packet_api:
      sectionSrc.includes("EVIDENCE_PACKET_API_PATH") ||
      uiContractSrc.includes("/api/claims/center/evidence-packet"),
    readiness_badge: uiContractSrc.includes("deriveEvidencePacketReadinessBadge"),
    loading_state: sectionSrc.includes("Loading evidence packet"),
    error_state: sectionSrc.includes("Could not load evidence packet"),
    empty_state: sectionSrc.includes("No evidence packet available"),
    drawer_fields_contract: uiContractSrc.includes("EVIDENCE_PACKET_DRAWER_FIELDS"),
    disabled_approve: pilotContractSrc.includes('"approve"'),
    disabled_reject: pilotContractSrc.includes('"reject"'),
    disabled_create_case: pilotContractSrc.includes('"create_case"'),
    disabled_build_pdf: pilotContractSrc.includes('"build_pdf"'),
    disabled_submit: pilotContractSrc.includes('"submit_claim"'),
    disabled_actions_component: viewSrc.includes("ClaimPilotReviewDisabledActions"),
    api_route_exists: fs.existsSync(path.join(process.cwd(), API_ROUTE)),
    no_hard_delete: !/DELETE\s+FROM/i.test(sectionSrc),
    no_scanner_import: !sectionSrc.includes("operator-mobile"),
    no_write_in_phase: !phaseSrc.includes(".insert(") && !phaseSrc.includes(".update("),
    pilot_review_route: viewSrc.includes("/claim-center/pilot-review"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-EVIDENCE-PACKET-UI-V1",
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
