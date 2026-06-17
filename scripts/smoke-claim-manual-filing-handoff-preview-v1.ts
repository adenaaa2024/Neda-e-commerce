/**
 * Smoke — PHASE-CLAIM-MANUAL-FILING-HANDOFF-PREVIEW-V1 (static checks)
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CLAIM_MANUAL_FILING_HANDOFF_UI_VERSION,
  MANUAL_FILING_HANDOFF_SECTION_ID,
  NOT_SUBMITTED_BANNER_TEXT,
} from "../lib/claims/submission/claim-manual-filing-handoff-ui-contract";

const UI_CONTRACT = "lib/claims/submission/claim-manual-filing-handoff-ui-contract.ts";
const SECTION = "components/claim-center/case-review/ClaimCaseReviewManualFilingHandoffSection.tsx";
const DRAWER = "components/claim-center/case-review/ClaimCaseReviewDetailDrawer.tsx";
const DISABLED = "components/claim-center/case-review/ClaimCaseReviewDisabledActions.tsx";
const CASE_CONTRACT = "lib/claims/pilot/claim-case-review-ui-contract.ts";

function main(): void {
  const root = process.cwd();
  const section = fs.readFileSync(path.join(root, SECTION), "utf8");
  const drawer = fs.readFileSync(path.join(root, DRAWER), "utf8");
  const contract = fs.readFileSync(path.join(root, UI_CONTRACT), "utf8");
  const disabled = fs.readFileSync(path.join(root, DISABLED), "utf8");
  const caseContract = fs.readFileSync(path.join(root, CASE_CONTRACT), "utf8");

  const checks = {
    contract_exists: fs.existsSync(path.join(root, UI_CONTRACT)),
    section_exists: fs.existsSync(path.join(root, SECTION)),
    drawer_handoff_section: drawer.includes("ClaimCaseReviewManualFilingHandoffSection"),
    section_id: section.includes("MANUAL_FILING_HANDOFF_SECTION_ID"),
    not_submitted_banner:
      section.includes("NOT_SUBMITTED_BANNER_TEXT") ||
      contract.includes("NOT SUBMITTED TO AMAZON"),
    checklist_items: contract.includes("review_evidence_packet") && contract.includes("save_amazon_case_id_later"),
    trid_reference_graph: section.includes("TRID / reference graph"),
    draft_artifact_paths: section.includes("DRAFT artifact paths"),
    readiness_badges: section.includes("HANDOFF_READINESS_BADGE_LABELS") || contract.includes("ready_for_manual_filing"),
    disabled_create_submission:
      section.includes("MANUAL_FILING_HANDOFF_DISABLED_ACTIONS") && contract.includes("create_submission"),
    disabled_mark_filed:
      section.includes("MANUAL_FILING_HANDOFF_DISABLED_ACTIONS") && contract.includes("mark_as_filed"),
    disabled_amazon_submit:
      section.includes("MANUAL_FILING_HANDOFF_DISABLED_ACTIONS") && contract.includes("amazon_submit"),
    disabled_upload:
      section.includes("MANUAL_FILING_HANDOFF_DISABLED_ACTIONS") && contract.includes("upload_evidence"),
    remediated_disable: section.includes("manualFilingHandoffDisabled"),
    case_contract_handoff_field: caseContract.includes("manual_filing_handoff"),
    disabled_actions_extended: caseContract.includes("mark_as_filed") && caseContract.includes("upload_evidence"),
    global_disabled_submit: disabled.includes("CASE_REVIEW_DISABLED_ACTIONS"),
    no_insert: !section.includes(".insert("),
    no_scanner: !section.includes("operator-mobile"),
    no_ai: !section.includes("openai"),
    no_amazon_api: !section.includes("amazon-sp-api"),
    version_constant: contract.includes(CLAIM_MANUAL_FILING_HANDOFF_UI_VERSION),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  console.log(
    JSON.stringify({
      smoke: failures.length === 0 ? "pass" : "fail",
      version: CLAIM_MANUAL_FILING_HANDOFF_UI_VERSION,
      failures,
    }),
  );
  if (failures.length > 0) process.exitCode = 1;
}

main();
