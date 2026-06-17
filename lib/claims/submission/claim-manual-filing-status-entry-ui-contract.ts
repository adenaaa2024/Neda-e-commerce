/**
 * PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-V1
 * UI contract + client dry-run preview for manual filing status entry (no DB writes).
 */
import type { ReimbursementTrackingPreviewRow } from "./claim-reimbursement-tracking-preview-v1";
import {
  AUDIT_EVENT_CONTRACT,
  MANUAL_FILING_RECORD_CONFIRMATION_TEXT,
  MANUAL_FILING_SAFETY_BANNER,
  RECOMMENDED_DB_STATUS_TRANSITION,
  UI_MODAL_CONTRACT,
} from "./claim-manual-filing-status-entry-plan-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import { referenceGraphVerified } from "./claim-reimbursement-tracking-ui-contract";

export const MANUAL_FILING_STATUS_ENTRY_UI_VERSION =
  "claim-manual-filing-status-entry-ui-v1" as const;

export const MANUAL_FILING_BUTTON_TOOLTIP = "This will not submit anything to Amazon." as const;

export const MANUAL_FILING_EXECUTE_DISABLED_TOOLTIP =
  "Save is disabled until APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes in operator approval file." as const;

export const MANUAL_FILING_UI_DRY_RUN_BANNER =
  "This does not submit anything to Amazon. It only updates internal tracking after execute approval." as const;

export type ManualFilingFormState = {
  amazon_case_id: string;
  filed_at: string;
  amazon_case_url: string;
  filing_notes: string;
  attestation: boolean;
};

export const EMPTY_MANUAL_FILING_FORM: ManualFilingFormState = {
  amazon_case_id: "",
  filed_at: "",
  amazon_case_url: "",
  filing_notes: "",
  attestation: false,
};

export type ManualFilingStatusCard = {
  current_status: string;
  external_amazon_case_id: string;
  filing_status: string;
  next_action: string;
};

export type ManualFilingEligibility = {
  can_open_modal: boolean;
  button_enabled: boolean;
  disabled_reason: string | null;
  status_card: ManualFilingStatusCard;
};

export type ManualFilingDryRunPreview = {
  dry_run: true;
  mode: "preview_only";
  claim_submission_id: string;
  claim_case_id: string;
  old_status: string;
  new_status: typeof RECOMMENDED_DB_STATUS_TRANSITION.after_record_manual_filing;
  new_tracking_status: "filed_waiting_for_amazon" | "manually_filed_pending_external_id";
  submission_id_preview: string | null;
  source_payload_preview: Record<string, unknown>;
  audit_event_preview: Record<string, unknown>;
  would_write: false;
  write_enabled: boolean;
  execute_phase_required: "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-AND-GUARDED-EXECUTE-V1";
};

export type ManualFilingFormValidation = {
  valid: boolean;
  errors: Partial<Record<keyof ManualFilingFormState, string>>;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function hasExportArtifacts(row: ReimbursementTrackingPreviewRow): boolean {
  const paths = row.export_artifact_paths;
  if (paths && Object.keys(paths).length > 0) return true;
  const lanes = row.money_lanes;
  return !!str(lanes.export_run_id);
}

export function buildManualFilingStatusCard(row: ReimbursementTrackingPreviewRow): ManualFilingStatusCard {
  const externalId = str(row.future_amazon_case_id);
  const st = str(row.submission_status).toLowerCase() || "draft";
  const filed = externalId.length > 0 || ["submitted", "investigating", "accepted"].includes(st);

  return {
    current_status: st || "draft",
    external_amazon_case_id: externalId || "missing",
    filing_status: filed ? "recorded" : "not recorded",
    next_action: filed
      ? "Waiting for reimbursement match or Amazon response"
      : "File manually in Amazon, then record the case ID here",
  };
}

export function assessManualFilingRecordEligibility(
  row: ReimbursementTrackingPreviewRow,
): ManualFilingEligibility {
  const statusCard = buildManualFilingStatusCard(row);
  const st = str(row.submission_status).toLowerCase();
  const externalId = str(row.future_amazon_case_id);
  const graphOk = referenceGraphVerified(row);
  const exportOk = hasExportArtifacts(row);
  const blockers = row.detail_preview.blockers.length;

  let disabled_reason: string | null = null;

  if (externalId) {
    disabled_reason = "Amazon case ID already recorded on this submission.";
  } else if (!["draft", "ready_to_send"].includes(st)) {
    disabled_reason = `Submission status "${st || "unknown"}" is not eligible for manual filing record.`;
  } else if (!row.not_submitted_to_amazon) {
    disabled_reason = "Legacy or non-pilot submission rows cannot be recorded here.";
  } else if (!graphOk) {
    disabled_reason = "Reference graph is incomplete — resolve references before recording filing.";
  } else if (!exportOk) {
    disabled_reason = "Filing packet / export artifacts are missing.";
  } else if (blockers > 0) {
    disabled_reason = "Submission has open blockers — review before recording filing.";
  }

  const button_enabled = disabled_reason == null;

  return {
    can_open_modal: button_enabled,
    button_enabled,
    disabled_reason,
    status_card: statusCard,
  };
}

export function validateManualFilingForm(form: ManualFilingFormState): ManualFilingFormValidation {
  const errors: Partial<Record<keyof ManualFilingFormState, string>> = {};
  const caseId = str(form.amazon_case_id);
  if (!caseId) errors.amazon_case_id = "Amazon Case ID is required.";
  else if (caseId.length < 3) errors.amazon_case_id = "Enter a valid Amazon case ID.";

  if (!str(form.filed_at)) errors.filed_at = "Filed date/time is required.";
  else if (Number.isNaN(Date.parse(form.filed_at))) errors.filed_at = "Enter a valid date and time.";

  const url = str(form.amazon_case_url);
  if (url && !/^https?:\/\//i.test(url)) {
    errors.amazon_case_url = "URL must start with http:// or https://";
  }

  if (!form.attestation) {
    errors.attestation = MANUAL_FILING_RECORD_CONFIRMATION_TEXT;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export function buildManualFilingDryRunPreview(
  row: ReimbursementTrackingPreviewRow,
  form: ManualFilingFormState,
  actorId?: string | null,
): ManualFilingDryRunPreview {
  const oldStatus = str(row.submission_status) || "draft";
  const caseId = str(form.amazon_case_id);
  const filedAtIso = new Date(form.filed_at).toISOString();
  const newTrackingStatus = caseId ? "filed_waiting_for_amazon" : "manually_filed_pending_external_id";

  const source_payload_preview: Record<string, unknown> = {
    claim_case_id: row.claim_case_id,
    portal_filed_at: filedAtIso,
    operator_filed_by: actorId ?? null,
    amazon_case_url: str(form.amazon_case_url) || null,
    manual_filing_notes: str(form.filing_notes) || null,
    manual_filing_recorded: false,
    external_platform: "amazon_seller_central",
    manual_filing_record_dry_run: true,
    manual_filing_record_ui_version: MANUAL_FILING_STATUS_ENTRY_UI_VERSION,
    manual_filing_tracking_status: newTrackingStatus,
    not_submitted_to_amazon: true,
    attestation_text: MANUAL_FILING_RECORD_CONFIRMATION_TEXT,
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  };

  const audit_event_preview: Record<string, unknown> = {
    event_type: AUDIT_EVENT_CONTRACT.event_type,
    claim_submission_id: row.claim_submission_id,
    claim_case_id: row.claim_case_id,
    old_status: oldStatus,
    new_status: RECOMMENDED_DB_STATUS_TRANSITION.after_record_manual_filing,
    external_case_id: caseId || null,
    filed_at: filedAtIso,
    filed_by: actorId ?? null,
    notes: str(form.filing_notes) || null,
    external_case_url: str(form.amazon_case_url) || null,
    new_tracking_status: newTrackingStatus,
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    dry_run: true,
  };

  return {
    dry_run: true,
    mode: "preview_only",
    claim_submission_id: row.claim_submission_id,
    claim_case_id: row.claim_case_id,
    old_status: oldStatus,
    new_status: RECOMMENDED_DB_STATUS_TRANSITION.after_record_manual_filing,
    new_tracking_status: newTrackingStatus,
    submission_id_preview: caseId || null,
    source_payload_preview,
    audit_event_preview,
    would_write: false,
    write_enabled: false,
    execute_phase_required: "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-AND-GUARDED-EXECUTE-V1",
  };
}

export const MANUAL_FILING_UI_COPY = {
  action_label: UI_MODAL_CONTRACT.action_label,
  modal_title: "Record manual filing",
  modal_subtitle:
    "Save the Amazon case details after you manually filed this claim. MENORIX will not contact Amazon.",
  safety_banner: MANUAL_FILING_UI_DRY_RUN_BANNER,
  confirmation_checkbox: MANUAL_FILING_RECORD_CONFIRMATION_TEXT,
  plan_safety_banner: MANUAL_FILING_SAFETY_BANNER,
  preview_heading: "Dry-run preview (no write)",
  save_label: UI_MODAL_CONTRACT.submit_button,
  cancel_label: UI_MODAL_CONTRACT.cancel_button,
} as const;
