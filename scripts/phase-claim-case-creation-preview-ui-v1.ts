/**
 * PHASE-CLAIM-CASE-CREATION-PREVIEW-UI-V1 — read-only case preview UI verify
 *   npx tsx scripts/phase-claim-case-creation-preview-ui-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  composeClaimCaseCreationPreviewV1,
  sampleCasePreviewForReport,
} from "../lib/claims/case-creation/claim-case-creation-preview-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "../lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import {
  CASE_PREVIEW_DRAWER_FIELDS,
  CASE_PREVIEW_BULK_MODE_LABELS,
  verifyCasePreviewDisplay,
} from "../lib/claims/pilot/claim-case-creation-preview-ui-contract";
import {
  DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
  buildClaimPilotReviewReadmodel,
} from "../lib/claims/pilot/claim-pilot-review-readmodel";
import { PILOT_REVIEW_DISABLED_ACTIONS } from "../lib/claims/pilot/claim-pilot-review-ui-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-case-creation-preview-ui-v1";
const PREVIEW_RESULTS =
  ".cursor/audit-reports/phase-claim-case-creation-preview-v1/20260615T170000Z/results.json";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const FILES_CHANGED = [
  "lib/claims/pilot/claim-case-creation-preview-ui-contract.ts",
  "lib/claims/case-creation/claim-case-creation-preview-v1.ts",
  "lib/claims/center/claim-center-api-handlers.ts",
  "app/api/claims/center/case-creation-preview/route.ts",
  "components/claim-center/pilot/ClaimPilotReviewCasePreviewSection.tsx",
  "components/claim-center/pilot/ClaimPilotReviewBulkCasePreviewPanel.tsx",
  "components/claim-center/pilot/ClaimPilotReviewDetailDrawer.tsx",
  "components/claim-center/pilot/ClaimPilotReviewEvidencePacketSection.tsx",
  "components/claim-center/pilot/ClaimPilotReviewTable.tsx",
  "components/claim-center/pilot/ClaimPilotReviewView.tsx",
  "scripts/phase-claim-case-creation-preview-ui-v1.ts",
  "scripts/smoke-claim-case-creation-preview-ui-v1.ts",
];

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function loadPrerequisites(): void {
  const p = path.join(process.cwd(), PREVIEW_RESULTS);
  if (!fs.existsSync(p)) throw new Error(`BLOCKED: preview evidence missing at ${PREVIEW_RESULTS}`);
  const preview = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;
  if (preview.SAFE_CASE_CREATION_PREVIEW_READY !== "yes") {
    throw new Error("BLOCKED: SAFE_CASE_CREATION_PREVIEW_READY must be yes");
  }
  if (preview.SAFE_TO_PLAN_CASE_CREATION_PILOT !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_PLAN_CASE_CREATION_PILOT must be yes");
  }
}

function readUiSources() {
  const drawer = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/pilot/ClaimPilotReviewDetailDrawer.tsx"),
    "utf8",
  );
  const caseSection = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/pilot/ClaimPilotReviewCasePreviewSection.tsx"),
    "utf8",
  );
  const bulkPanel = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/pilot/ClaimPilotReviewBulkCasePreviewPanel.tsx"),
    "utf8",
  );
  const view = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/pilot/ClaimPilotReviewView.tsx"),
    "utf8",
  );
  const disabled = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/pilot/ClaimPilotReviewDisabledActions.tsx"),
    "utf8",
  );
  return { drawer, caseSection, bulkPanel, view, disabled };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  loadPrerequisites();

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  const candidatesBefore = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsBefore = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const pilotPayload = await buildClaimPilotReviewReadmodel(client, ORG, STORE, {
    intake_run_id: DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 100,
  });

  const shipmentRow = pilotPayload.rows.find((r) => r.family_key_v3 === "removal_shipment_missing");
  const orderRow = pilotPayload.rows.find((r) => r.family_key_v3 === "removal_order_discrepancy");
  if (!shipmentRow || !orderRow) {
    throw new Error("BLOCKED: need shipment + order pilot rows");
  }

  const singleShipment = await composeClaimCaseCreationPreviewV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    candidate_ids: [shipmentRow.id],
    limit: 50,
  });
  const singleOrder = await composeClaimCaseCreationPreviewV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    candidate_ids: [orderRow.id],
    limit: 50,
  });
  const bulkAll = await composeClaimCaseCreationPreviewV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 50,
  });
  const bulkSelected = await composeClaimCaseCreationPreviewV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    candidate_ids: [shipmentRow.id, orderRow.id],
    limit: 50,
  });

  const candidatesAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsAfter = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const scannerAfter = scannerGitStatus();

  const ui = readUiSources();

  const shipmentPreview = singleShipment.case_previews[0];
  const orderPreview = singleOrder.case_previews[0];

  const sampleCandidateVerification = {
    removal_shipment_missing: shipmentPreview
      ? { ...sampleCasePreviewForReport(shipmentPreview), display: verifyCasePreviewDisplay(shipmentPreview) }
      : null,
    removal_order_discrepancy: orderPreview
      ? { ...sampleCasePreviewForReport(orderPreview), display: verifyCasePreviewDisplay(orderPreview) }
      : null,
  };

  const bulkVerification = {
    all_pilot: {
      evaluated: bulkAll.summary.evaluated_candidate_count,
      proposed: bulkAll.summary.proposed_case_count,
      grouping: bulkAll.summary.proposed_grouping_summary,
      family: bulkAll.summary.family_distribution,
    },
    selected_two: {
      evaluated: bulkSelected.summary.evaluated_candidate_count,
      proposed: bulkSelected.summary.proposed_case_count,
    },
    grouped_mode_label_present: Object.keys(CASE_PREVIEW_BULK_MODE_LABELS).includes("grouped"),
  };

  const disabledContract = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/pilot/claim-pilot-review-ui-contract.ts"),
    "utf8",
  );

  const disabledVerification = {
    pilot_review_disabled_actions_defined:
      disabledContract.includes("PILOT_REVIEW_DISABLED_ACTIONS") &&
      disabledContract.includes('"create_case"') &&
      disabledContract.includes('"submit_claim"') &&
      disabledContract.includes('"build_pdf"') &&
      disabledContract.includes('"approve"'),
    ui_buttons_disabled:
      ui.disabled.includes("PILOT_REVIEW_DISABLED_ACTIONS") &&
      ui.disabled.includes("disabled") &&
      ui.disabled.includes('aria-disabled="true"'),
    disabled_placeholder_marker: ui.disabled.includes("disabled-placeholder-only"),
    disabled_action_count: PILOT_REVIEW_DISABLED_ACTIONS.length,
  };

  const uiSectionsAdded = {
    drawer_case_preview_section: ui.drawer.includes("ClaimPilotReviewCasePreviewSection"),
    bulk_case_preview_panel: ui.view.includes("ClaimPilotReviewBulkCasePreviewPanel"),
    evidence_packet_link: ui.caseSection.includes("EVIDENCE_PACKET_SECTION_ID"),
    table_multi_select: ui.view.includes("checkedIds"),
    api_route_exists: fs.existsSync(
      path.join(process.cwd(), "app/api/claims/center/case-creation-preview/route.ts"),
    ),
  };

  const noDbWrite =
    candidatesBefore === candidatesAfter &&
    casesBefore === casesAfter &&
    submissionsBefore === submissionsAfter;

  let buildResult = "pending";
  let smokeResult = "pending";
  try {
    const lock = path.join(process.cwd(), ".next/lock");
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    execSync("npm run build", { stdio: "pipe", encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`;
  }
  try {
    execSync(`npx tsx scripts/smoke-claim-case-creation-preview-ui-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const uiPass =
    pilotPayload.rows.length === 50 &&
    singleShipment.case_previews.length === 1 &&
    singleOrder.case_previews.length === 1 &&
    bulkAll.summary.proposed_case_count === 50 &&
    bulkSelected.summary.proposed_case_count === 2 &&
    bulkAll.summary.family_distribution.removal_shipment_missing === 30 &&
    uiSectionsAdded.drawer_case_preview_section &&
    uiSectionsAdded.bulk_case_preview_panel &&
    uiSectionsAdded.evidence_packet_link &&
    disabledVerification.pilot_review_disabled_actions_defined &&
    disabledVerification.ui_buttons_disabled &&
    disabledVerification.disabled_placeholder_marker &&
    noDbWrite &&
    scannerBefore === scannerAfter &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-CASE-CREATION-PREVIEW-UI-V1",
    run_id: id,
    mode: "read-only-ui-preview",
    original_ref: PRODUCTION_REF,
    pilot_intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    files_changed: FILES_CHANGED,
    UI_sections_added: uiSectionsAdded,
    case_preview_fields: [...CASE_PREVIEW_DRAWER_FIELDS],
    bulk_preview_behavior: {
      modes: Object.keys(CASE_PREVIEW_BULK_MODE_LABELS),
      selected: "checkbox multi-select + candidate_ids API param",
      all_pilot: "limit 50 intake_run scoped",
      grouped: "grouping summary from preview payload proposed_grouping_summary",
    },
    sample_candidate_preview_verification: sampleCandidateVerification,
    sample_bulk_preview_verification: bulkVerification,
    disabled_actions_verification: disabledVerification,
    no_db_write_verification: {
      pass: noDbWrite,
      claim_candidates_before: candidatesBefore,
      claim_candidates_after: candidatesAfter,
      claim_cases_before: casesBefore,
      claim_cases_after: casesAfter,
      claim_submissions_before: submissionsBefore,
      claim_submissions_after: submissionsAfter,
    },
    no_claim_candidate_mutation_verification: {
      pass: candidatesBefore === candidatesAfter,
      before: candidatesBefore,
      after: candidatesAfter,
    },
    no_claim_case_mutation_verification: {
      pass: casesBefore === casesAfter,
      before: casesBefore,
      after: casesAfter,
    },
    no_claim_submission_mutation_verification: {
      pass: submissionsBefore === submissionsAfter,
      before: submissionsBefore,
      after: submissionsAfter,
    },
    no_scanner_change_verification: {
      pass: scannerBefore === scannerAfter,
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_REVIEW_CASE_CREATION_PREVIEW_UI: uiPass ? "yes" : "no",
    SAFE_TO_BUILD_CASE_CREATION_PILOT: uiPass ? "yes" : "no",
    NEXT_PROMPT: uiPass
      ? "PHASE-CLAIM-CASE-CREATION-PILOT-V1 — controlled INSERT on original pilot after Maysam approval; scope intake_run_id a8a892fe only"
      : "PHASE-CLAIM-CASE-CREATION-PREVIEW-UI-V1-REMEDIATION — fix failing UI verify checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Case creation preview UI V1

**Run:** ${id} · **Ref:** ${PRODUCTION_REF}

- Pilot rows: **${pilotPayload.rows.length}**
- Bulk proposed: **${bulkAll.summary.proposed_case_count}**
- SAFE_TO_REVIEW_CASE_CREATION_PREVIEW_UI: **${results.SAFE_TO_REVIEW_CASE_CREATION_PREVIEW_UI}**
`,
  );

  console.log(
    JSON.stringify({
      ok: uiPass,
      run_id: id,
      pilot_rows: pilotPayload.rows.length,
      bulk_proposed: bulkAll.summary.proposed_case_count,
      SAFE_TO_REVIEW_CASE_CREATION_PREVIEW_UI: results.SAFE_TO_REVIEW_CASE_CREATION_PREVIEW_UI,
      outDir,
    }),
  );
  if (!uiPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
