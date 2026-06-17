/**
 * PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-AND-GUARDED-EXECUTE-V1
 * Combined UI + guarded execute contract, schema audit, and phase verification helpers.
 */
import "server-only";

import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  EXISTING_SCHEMA_SUPPORT,
  PROPOSED_ADDITIVE_MIGRATION_SQL,
  probeClaimSubmissionsSchemaLive,
  snapshotPilotSubmissions,
  DUPLICATE_EXTERNAL_CASE_ID_RULE,
  AUDIT_EVENT_CONTRACT,
} from "./claim-manual-filing-status-entry-plan-v1";
import {
  assessManualFilingRecordEligibility,
  validateManualFilingForm,
  type ManualFilingFormState,
} from "./claim-manual-filing-status-entry-ui-contract";
import {
  MANUAL_FILING_WRITE_APPROVAL_PATH,
  readManualFilingWriteApprovalStatus,
} from "./claim-manual-filing-status-entry-write-approval-server-v1";
import { composeReimbursementTrackingPreviewV1 } from "./claim-reimbursement-tracking-preview-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";

export const MANUAL_FILING_STATUS_ENTRY_UI_AND_EXECUTE_V1 =
  "claim-manual-filing-status-entry-ui-and-guarded-execute-v1" as const;

export {
  MANUAL_FILING_WRITE_APPROVAL_PATH,
  MANUAL_FILING_WRITE_APPROVAL_KEY,
  readManualFilingWriteApprovalStatus,
  type ManualFilingWriteApprovalStatus,
} from "./claim-manual-filing-status-entry-write-approval-server-v1";

export const MANUAL_FILING_MIGRATION_FILE =
  "supabase/migrations/20260618140000_phase_manual_filing_status_entry_guarded_execute_v1.sql";

export type ManualFilingSchemaAudit = {
  schema_support: typeof EXISTING_SCHEMA_SUPPORT;
  migration_needed: boolean;
  migration_required_for_pilot_v1: boolean;
  migration_file_if_needed: string | null;
  live_db_probe: Record<string, unknown>;
};

export async function auditManualFilingSchemaV1(
  client: SupabaseClient,
  organizationId: string,
): Promise<ManualFilingSchemaAudit> {
  const live_db_probe = await probeClaimSubmissionsSchemaLive(client, organizationId);
  const missing = EXISTING_SCHEMA_SUPPORT.filter((f) => !f.supported);
  const migration_needed = missing.length > 0;
  const migrationFileExists = fs.existsSync(path.join(process.cwd(), MANUAL_FILING_MIGRATION_FILE));

  return {
    schema_support: EXISTING_SCHEMA_SUPPORT,
    migration_needed,
    migration_required_for_pilot_v1: false,
    migration_file_if_needed:
      migration_needed && migrationFileExists ? MANUAL_FILING_MIGRATION_FILE : migration_needed ? PROPOSED_ADDITIVE_MIGRATION_SQL.slice(0, 80) + "…" : null,
    live_db_probe,
  };
}

export function verifyManualFilingUiIntegrationStatic(): {
  modal_verification: boolean;
  validation_verification: boolean;
  detail_drawer_section: boolean;
  execute_route_present: boolean;
  guarded_execute_lib: boolean;
  approval_file_present: boolean;
} {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  const drawer = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx");
  const modal = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingManualFilingModal.tsx");
  const section = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingManualFilingSection.tsx");

  const shipment = validateManualFilingForm({
    amazon_case_id: "",
    filed_at: "",
    amazon_case_url: "",
    filing_notes: "",
    attestation: false,
  });
  const valid = validateManualFilingForm({
    amazon_case_id: "AMZ-123",
    filed_at: "2026-06-10T12:00",
    amazon_case_url: "",
    filing_notes: "",
    attestation: true,
  });

  return {
    modal_verification:
      modal.includes("MANUAL_FILING_UI_COPY.modal_title") &&
      modal.includes("Preview dry-run") &&
      section.includes("MANUAL_FILING_UI_COPY.action_label"),
    validation_verification: !shipment.valid && valid.valid,
    detail_drawer_section: drawer.includes("ReimbursementTrackingManualFilingSection"),
    execute_route_present: fs.existsSync(
      path.join(process.cwd(), "app/api/claims/center/manual-filing-status-entry/execute/route.ts"),
    ),
    guarded_execute_lib: fs.existsSync(
      path.join(process.cwd(), "lib/claims/submission/claim-manual-filing-status-entry-guarded-execute-v1.ts"),
    ),
    approval_file_present: fs.existsSync(path.join(process.cwd(), MANUAL_FILING_WRITE_APPROVAL_PATH)),
  };
}

export async function findPilotModalSamplesV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<{
  shipment_missing: { claim_submission_id: string; eligibility: ReturnType<typeof assessManualFilingRecordEligibility> } | null;
  order_discrepancy: { claim_submission_id: string; eligibility: ReturnType<typeof assessManualFilingRecordEligibility> } | null;
}> {
  const composed = await composeReimbursementTrackingPreviewV1(client, organizationId, storeId, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  let shipment_missing: {
    claim_submission_id: string;
    eligibility: ReturnType<typeof assessManualFilingRecordEligibility>;
  } | null = null;
  let order_discrepancy: {
    claim_submission_id: string;
    eligibility: ReturnType<typeof assessManualFilingRecordEligibility>;
  } | null = null;

  for (const row of composed.previews) {
    const fam = String(row.family_key_v3 ?? row.claim_family ?? "");
    const eligibility = assessManualFilingRecordEligibility(row);
    if (!shipment_missing && fam.includes("removal_shipment_missing") && eligibility.can_open_modal) {
      shipment_missing = { claim_submission_id: row.claim_submission_id, eligibility };
    }
    if (!order_discrepancy && fam.includes("removal_order_discrepancy") && eligibility.can_open_modal) {
      order_discrepancy = { claim_submission_id: row.claim_submission_id, eligibility };
    }
  }

  return { shipment_missing, order_discrepancy };
}

export function buildDryRunStatusChangePreview(
  form: ManualFilingFormState,
  oldStatus: string,
): {
  old_status: string;
  new_db_status: "submitted";
  new_tracking_status: "filed_waiting_for_amazon" | "manually_filed_pending_external_id";
} {
  const caseId = String(form.amazon_case_id ?? "").trim();
  return {
    old_status: oldStatus,
    new_db_status: "submitted",
    new_tracking_status: caseId ? "filed_waiting_for_amazon" : "manually_filed_pending_external_id",
  };
}

export async function snapshotPilotForExecutePhase(
  client: SupabaseClient,
  organizationId: string,
): Promise<Record<string, unknown>> {
  return snapshotPilotSubmissions(client, organizationId);
}

export const MANUAL_FILING_EXECUTE_MANIFEST = {
  version: MANUAL_FILING_STATUS_ENTRY_UI_AND_EXECUTE_V1,
  audit_event_contract: AUDIT_EVENT_CONTRACT,
  duplicate_external_case_id_rule: DUPLICATE_EXTERNAL_CASE_ID_RULE,
  pilot_case_run_id: PILOT_CASE_RUN_ID,
  intake_run_id: PILOT_INTAKE_RUN_ID,
} as const;
