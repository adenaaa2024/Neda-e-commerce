/**
 * Server-side dry-run composer for manual filing status entry — no DB writes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { composeReimbursementTrackingPreviewV1 } from "./claim-reimbursement-tracking-preview-v1";
import {
  buildManualFilingDryRunPreview,
  type ManualFilingDryRunPreview,
  type ManualFilingFormState,
  validateManualFilingForm,
  assessManualFilingRecordEligibility,
  MANUAL_FILING_STATUS_ENTRY_UI_VERSION,
} from "./claim-manual-filing-status-entry-ui-contract";
import { readManualFilingWriteApprovalStatus } from "./claim-manual-filing-status-entry-write-approval-server-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";

export type ManualFilingDryRunRequest = {
  claim_submission_id: string;
  amazon_case_id: string;
  filed_at: string;
  amazon_case_url?: string;
  filing_notes?: string;
  attestation: boolean;
  pilot_case_run_id?: string;
  intake_run_id?: string;
};

export type ManualFilingDryRunResponse = {
  version: typeof MANUAL_FILING_STATUS_ENTRY_UI_VERSION;
  dry_run: true;
  write_approval_status: ReturnType<typeof readManualFilingWriteApprovalStatus>;
  eligibility: ReturnType<typeof assessManualFilingRecordEligibility>;
  validation: ReturnType<typeof validateManualFilingForm>;
  preview: ManualFilingDryRunPreview | null;
  error: string | null;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

export async function composeManualFilingStatusEntryDryRunV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  body: ManualFilingDryRunRequest,
  actorId?: string | null,
): Promise<ManualFilingDryRunResponse> {
  const pilotCaseRunId = str(body.pilot_case_run_id) || PILOT_CASE_RUN_ID;
  const intakeRunId = str(body.intake_run_id) || PILOT_INTAKE_RUN_ID;
  const write_approval_status = readManualFilingWriteApprovalStatus();

  const composed = await composeReimbursementTrackingPreviewV1(client, organizationId, storeId, {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
  });

  const row = composed.previews.find((p) => p.claim_submission_id === body.claim_submission_id) ?? null;
  if (!row) {
    return {
      version: MANUAL_FILING_STATUS_ENTRY_UI_VERSION,
      dry_run: true,
      write_approval_status,
      eligibility: {
        can_open_modal: false,
        button_enabled: false,
        disabled_reason: "Pilot submission not found in scope.",
        status_card: {
          current_status: "unknown",
          external_amazon_case_id: "missing",
          filing_status: "not recorded",
          next_action: "Select a pilot submission row.",
        },
      },
      validation: { valid: false, errors: { amazon_case_id: "Submission not in pilot scope." } },
      preview: null,
      error: "claim_submission_id not found in pilot preview scope.",
    };
  }

  const form: ManualFilingFormState = {
    amazon_case_id: str(body.amazon_case_id),
    filed_at: str(body.filed_at),
    amazon_case_url: str(body.amazon_case_url),
    filing_notes: str(body.filing_notes),
    attestation: body.attestation === true,
  };

  const eligibility = assessManualFilingRecordEligibility(row);
  const validation = validateManualFilingForm(form);

  if (!validation.valid || !eligibility.button_enabled) {
    return {
      version: MANUAL_FILING_STATUS_ENTRY_UI_VERSION,
      dry_run: true,
      write_approval_status,
      eligibility,
      validation,
      preview: null,
      error: eligibility.disabled_reason ?? "Validation failed.",
    };
  }

  return {
    version: MANUAL_FILING_STATUS_ENTRY_UI_VERSION,
    dry_run: true,
    write_approval_status,
    eligibility,
    validation,
    preview: {
      ...buildManualFilingDryRunPreview(row, form, actorId),
      write_enabled: write_approval_status.write_enabled,
    },
    error: null,
  };
}
