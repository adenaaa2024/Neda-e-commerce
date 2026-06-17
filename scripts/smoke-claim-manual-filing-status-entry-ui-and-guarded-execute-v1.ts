/**
 * Smoke — PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-AND-GUARDED-EXECUTE-V1
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildManualFilingDryRunPreview,
  validateManualFilingForm,
  assessManualFilingRecordEligibility,
} from "../lib/claims/submission/claim-manual-filing-status-entry-ui-contract";
import {
  MANUAL_FILING_STATUS_ENTRY_UI_AND_EXECUTE_V1,
  readManualFilingWriteApprovalStatus,
  verifyManualFilingUiIntegrationStatic,
} from "../lib/claims/submission/claim-manual-filing-status-entry-ui-and-guarded-execute-v1";
import type { ReimbursementTrackingPreviewRow } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
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

const approval = readManualFilingWriteApprovalStatus();
assert.equal(approval.write_enabled, false, "write must default disabled");

const ui = verifyManualFilingUiIntegrationStatic();
assert.equal(ui.modal_verification, true);
assert.equal(ui.execute_route_present, true);
assert.equal(ui.guarded_execute_lib, true);

const shipment = sampleRow({ family_key_v3: "removal_shipment_missing" });
const order = sampleRow({
  claim_submission_id: "sub-2",
  family_key_v3: "removal_order_discrepancy",
  claim_family: "removal_order_discrepancy",
});

assert.equal(assessManualFilingRecordEligibility(shipment).button_enabled, true);
assert.equal(assessManualFilingRecordEligibility(order).button_enabled, true);

const preview = buildManualFilingDryRunPreview(shipment, {
  amazon_case_id: "AMZ-CASE-123",
  filed_at: "2026-06-10T12:00",
  amazon_case_url: "",
  filing_notes: "",
  attestation: true,
});

assert.equal(preview.old_status, "draft");
assert.equal(preview.new_status, "submitted");
assert.equal(preview.new_tracking_status, "filed_waiting_for_amazon");
assert.equal(preview.write_enabled, false);

const modal = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingManualFilingModal.tsx");
assert.match(modal, /Preview dry-run/);
assert.match(modal, /MANUAL_FILING_EXECUTE_DISABLED_TOOLTIP/);
assert.match(modal, /manual-filing-status-entry\/execute/);
assert.doesNotMatch(read("lib/claims/submission/claim-manual-filing-status-entry-guarded-execute-v1.ts"), /amazon-sp-api/);

console.log(
  JSON.stringify({
    smoke: "pass",
    version: MANUAL_FILING_STATUS_ENTRY_UI_AND_EXECUTE_V1,
    write_approval: approval,
    ui_verification: ui,
    validation_verification: validateManualFilingForm({
      amazon_case_id: "AMZ-1",
      filed_at: "2026-06-10T12:00",
      amazon_case_url: "",
      filing_notes: "",
      attestation: true,
    }).valid,
    dry_run_status_change_preview: {
      old_status: preview.old_status,
      new_status: preview.new_status,
      new_tracking_status: preview.new_tracking_status,
    },
  }),
);
