/**
 * Smoke — PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-V1 (static checks)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assessManualFilingRecordEligibility,
  buildManualFilingDryRunPreview,
  MANUAL_FILING_STATUS_ENTRY_UI_VERSION,
  validateManualFilingForm,
} from "../lib/claims/submission/claim-manual-filing-status-entry-ui-contract";
import type { ReimbursementTrackingPreviewRow } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(REPO, rel));
}

function sampleRow(overrides: Partial<ReimbursementTrackingPreviewRow> = {}): ReimbursementTrackingPreviewRow {
  return {
    claim_submission_id: "sub-1",
    claim_case_id: "case-1",
    submission_mode: "manual_filing",
    submission_status: "draft",
    claim_family: "removal_shipment_missing",
    family_key_v3: "removal_shipment_missing",
    source_event_key: "TRK-1",
    source_event_date: "2026-06-01",
    asin: "B001",
    fnsku: "X001",
    sku: "SKU1",
    product_identity: { asin: "B001", fnsku: "X001", sku: "SKU1", resolved_product_id: null },
    clean_quantity: 1,
    reference_edges_summary: [],
    estimated_amount: null,
    recovery_value: null,
    observed_reimbursement: null,
    financial_gap: null,
    money_warnings: [],
    money_lanes: {},
    export_artifact_paths: { html: "/tmp/draft.html" },
    future_amazon_case_id: null,
    reimbursement_tracking_status: "draft_not_filed",
    linked_reimbursement_rows: [],
    linked_transaction_rows: [],
    linked_settlement_rows: [],
    linked_reimbursement_count: 0,
    match_confidence: "none",
    follow_up_needed: true,
    not_submitted_to_amazon: true,
    claim_lines: [],
    detail_preview: {
      reference_graph_lines: [{ kind: "tracking", value: "TRK-1", source: "test" }],
      reimbursement_match_candidates: [],
      financial_gap_explanation: "gap null",
      warnings: [],
      blockers: [],
    },
    ...overrides,
  };
}

function main(): void {
  const drawer = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx");
  const section = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingManualFilingSection.tsx");
  const modal = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingManualFilingModal.tsx");
  const dryRunLib = read("lib/claims/submission/claim-manual-filing-status-entry-dry-run-v1.ts");
  const apiRoute = read("app/api/claims/center/manual-filing-status-entry/dry-run/route.ts");

  const shipment = sampleRow({ family_key_v3: "removal_shipment_missing" });
  const order = sampleRow({
    claim_submission_id: "sub-2",
    family_key_v3: "removal_order_discrepancy",
    claim_family: "removal_order_discrepancy",
  });

  const eligibleShipment = assessManualFilingRecordEligibility(shipment);
  const eligibleOrder = assessManualFilingRecordEligibility(order);
  const invalidForm = validateManualFilingForm({
    amazon_case_id: "",
    filed_at: "",
    amazon_case_url: "",
    filing_notes: "",
    attestation: false,
  });
  const validForm = validateManualFilingForm({
    amazon_case_id: "AMZ-CASE-123",
    filed_at: "2026-06-10T12:00",
    amazon_case_url: "https://sellercentral.amazon.com/case/123",
    filing_notes: "Filed manually",
    attestation: true,
  });
  const preview = buildManualFilingDryRunPreview(shipment, {
    amazon_case_id: "AMZ-CASE-123",
    filed_at: "2026-06-10T12:00",
    amazon_case_url: "",
    filing_notes: "",
    attestation: true,
  });

  const checks = {
    ui_contract: exists("lib/claims/submission/claim-manual-filing-status-entry-ui-contract.ts"),
    dry_run_lib: dryRunLib.includes("composeManualFilingStatusEntryDryRunV1"),
    api_dry_run_only: apiRoute.includes("dry_run: true") || dryRunLib.includes("dry_run: true"),
    no_db_update: !dryRunLib.includes(".update(") && !apiRoute.includes(".update("),
    drawer_section: drawer.includes("ReimbursementTrackingManualFilingSection"),
    modal_component: modal.includes("MANUAL_FILING_UI_COPY.modal_title"),
    status_card: section.includes("External Amazon Case ID"),
    save_disabled: modal.includes("disabled") && modal.includes("EXECUTE"),
    safety_copy: modal.includes("MANUAL_FILING_UI_COPY.safety_banner"),
    attestation: modal.includes("MANUAL_FILING_UI_COPY.confirmation_checkbox"),
    dry_run_preview_ui: modal.includes("Preview dry-run"),
    shipment_eligible: eligibleShipment.button_enabled,
    order_eligible: eligibleOrder.button_enabled,
    validation_required: !invalidForm.valid && validForm.valid,
    dry_run_preview_fields:
      preview.old_status === "draft" &&
      preview.new_status === "submitted" &&
      preview.submission_id_preview === "AMZ-CASE-123" &&
      preview.dry_run === true,
    no_amazon_api: !modal.includes("amazon-sp-api"),
    no_scanner_touch: !fs.existsSync(path.join(REPO, "app/scanner/operator-mobile/ReimbursementTrackingManualFilingModal.tsx")),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  console.log(
    JSON.stringify({
      smoke: failures.length === 0 ? "pass" : "fail",
      version: MANUAL_FILING_STATUS_ENTRY_UI_VERSION,
      failures,
      SAFE_MANUAL_FILING_STATUS_ENTRY_UI_READY: failures.length === 0 ? "yes" : "no",
      SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY_EXECUTE: failures.length === 0 ? "yes" : "no",
    }),
  );
  if (failures.length > 0) process.exitCode = 1;
}

main();
