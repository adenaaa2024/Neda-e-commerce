/**
 * PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-AND-GUARDED-EXECUTE-V1
 * Guarded UPDATE to claim_submissions — blocked unless APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AUDIT_EVENT_CONTRACT,
  DUPLICATE_EXTERNAL_CASE_ID_RULE,
  RECOMMENDED_DB_STATUS_TRANSITION,
} from "./claim-manual-filing-status-entry-plan-v1";
import {
  buildManualFilingDryRunPreview,
  type ManualFilingFormState,
  validateManualFilingForm,
  assessManualFilingRecordEligibility,
} from "./claim-manual-filing-status-entry-ui-contract";
import { composeManualFilingStatusEntryDryRunV1 } from "./claim-manual-filing-status-entry-dry-run-v1";
import {
  MANUAL_FILING_WRITE_APPROVAL_KEY,
  readManualFilingWriteApprovalStatus,
} from "./claim-manual-filing-status-entry-write-approval-server-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";

export type ManualFilingExecuteRequest = {
  claim_submission_id: string;
  amazon_case_id: string;
  filed_at: string;
  amazon_case_url?: string;
  filing_notes?: string;
  attestation: boolean;
  pilot_case_run_id?: string;
  intake_run_id?: string;
  execute_run_id?: string;
};

export type ManualFilingExecuteResult = {
  ok: boolean;
  blocked: boolean;
  blockReason: string | null;
  approvalKey: string;
  written: boolean;
  dryRunPreview: ReturnType<typeof buildManualFilingDryRunPreview> | null;
  audit_event_payload: Record<string, unknown> | null;
  duplicate_external_case_id_rule: typeof DUPLICATE_EXTERNAL_CASE_ID_RULE;
  before: { status: string | null; submission_id: string | null } | null;
  after: { status: string | null; submission_id: string | null } | null;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function deriveTrackingStatus(caseId: string): "filed_waiting_for_amazon" | "manually_filed_pending_external_id" {
  return caseId ? "filed_waiting_for_amazon" : "manually_filed_pending_external_id";
}

export async function checkDuplicateExternalCaseIdV1(args: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  externalCaseId: string;
  excludeSubmissionId: string;
}): Promise<{ duplicate: boolean; conflictingSubmissionId: string | null }> {
  const caseId = str(args.externalCaseId);
  if (!caseId) return { duplicate: false, conflictingSubmissionId: null };

  const { data, error } = await args.client
    .from("claim_submissions")
    .select("id, status")
    .eq("organization_id", args.organizationId)
    .eq("store_id", args.storeId)
    .eq("submission_id", caseId)
    .neq("id", args.excludeSubmissionId);

  if (error) return { duplicate: false, conflictingSubmissionId: null };

  const conflict = (data ?? []).find((r) => {
    const st = str((r as { status?: string }).status).toLowerCase();
    return st !== "rejected";
  }) as { id?: string } | undefined;

  return {
    duplicate: !!conflict?.id,
    conflictingSubmissionId: conflict?.id ?? null,
  };
}

export async function attemptGuardedManualFilingExecuteV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  body: ManualFilingExecuteRequest,
  actorId: string | null,
): Promise<ManualFilingExecuteResult> {
  const approval = readManualFilingWriteApprovalStatus();
  const executeRunId = str(body.execute_run_id) || `manual-filing-${Date.now()}`;

  const dryRunResponse = await composeManualFilingStatusEntryDryRunV1(
    client,
    organizationId,
    storeId,
    {
      claim_submission_id: body.claim_submission_id,
      amazon_case_id: body.amazon_case_id,
      filed_at: body.filed_at,
      amazon_case_url: body.amazon_case_url,
      filing_notes: body.filing_notes,
      attestation: body.attestation === true,
      pilot_case_run_id: body.pilot_case_run_id,
      intake_run_id: body.intake_run_id,
    },
    actorId,
  );

  const preview = dryRunResponse.preview;

  if (!approval.write_enabled) {
    return {
      ok: false,
      blocked: true,
      blockReason: `${MANUAL_FILING_WRITE_APPROVAL_KEY}=yes required in manual-filing-status-entry-write-v1-approval.md`,
      approvalKey: MANUAL_FILING_WRITE_APPROVAL_KEY,
      written: false,
      dryRunPreview: preview,
      audit_event_payload: preview?.audit_event_preview ?? null,
      duplicate_external_case_id_rule: DUPLICATE_EXTERNAL_CASE_ID_RULE,
      before: null,
      after: null,
    };
  }

  if (!dryRunResponse.validation.valid || !dryRunResponse.eligibility.button_enabled || !preview) {
    return {
      ok: false,
      blocked: false,
      blockReason: dryRunResponse.error ?? "Validation or eligibility failed.",
      approvalKey: MANUAL_FILING_WRITE_APPROVAL_KEY,
      written: false,
      dryRunPreview: preview,
      audit_event_payload: preview?.audit_event_preview ?? null,
      duplicate_external_case_id_rule: DUPLICATE_EXTERNAL_CASE_ID_RULE,
      before: null,
      after: null,
    };
  }

  const caseId = str(body.amazon_case_id);
  const dup = await checkDuplicateExternalCaseIdV1({
    client,
    organizationId,
    storeId,
    externalCaseId: caseId,
    excludeSubmissionId: body.claim_submission_id,
  });

  if (dup.duplicate) {
    return {
      ok: false,
      blocked: false,
      blockReason: `Duplicate external case ID for this store (conflict: ${dup.conflictingSubmissionId}).`,
      approvalKey: MANUAL_FILING_WRITE_APPROVAL_KEY,
      written: false,
      dryRunPreview: preview,
      audit_event_payload: preview.audit_event_preview,
      duplicate_external_case_id_rule: DUPLICATE_EXTERNAL_CASE_ID_RULE,
      before: null,
      after: null,
    };
  }

  const { data: row, error: fetchErr } = await client
    .from("claim_submissions")
    .select("id, status, submission_id, source_payload, store_id")
    .eq("organization_id", organizationId)
    .eq("id", body.claim_submission_id)
    .maybeSingle();

  if (fetchErr || !row) {
    return {
      ok: false,
      blocked: false,
      blockReason: fetchErr?.message ?? "Submission not found.",
      approvalKey: MANUAL_FILING_WRITE_APPROVAL_KEY,
      written: false,
      dryRunPreview: preview,
      audit_event_payload: preview.audit_event_preview,
      duplicate_external_case_id_rule: DUPLICATE_EXTERNAL_CASE_ID_RULE,
      before: null,
      after: null,
    };
  }

  const before = {
    status: str(row.status) || null,
    submission_id: str(row.submission_id) || null,
  };

  const priorPayload = metaRecord(row.source_payload);
  const filedAtIso = new Date(body.filed_at).toISOString();
  const trackingStatus = deriveTrackingStatus(caseId);
  const newDbStatus = RECOMMENDED_DB_STATUS_TRANSITION.after_record_manual_filing;

  const audit_event_payload: Record<string, unknown> = {
    ...preview.audit_event_preview,
    dry_run: false,
    run_id: executeRunId,
    event_type: AUDIT_EVENT_CONTRACT.event_type,
    new_tracking_status: trackingStatus,
    actor_id: actorId,
  };

  const nextPayload = {
    ...priorPayload,
    claim_case_id: priorPayload.claim_case_id ?? preview.claim_case_id,
    portal_filed_at: filedAtIso,
    operator_filed_by: actorId,
    amazon_case_url: str(body.amazon_case_url) || null,
    manual_filing_notes: str(body.filing_notes) || null,
    manual_filing_recorded: true,
    external_platform: "amazon_seller_central",
    manual_filing_recorded_at: new Date().toISOString(),
    manual_filing_record_execute_run_id: executeRunId,
    manual_filing_record_dry_run: false,
    manual_filing_tracking_status: trackingStatus,
    not_submitted_to_amazon: true,
    pilot_case_run_id: priorPayload.pilot_case_run_id ?? PILOT_CASE_RUN_ID,
    intake_run_id: priorPayload.intake_run_id ?? PILOT_INTAKE_RUN_ID,
    manual_filing_audit_events: [
      ...(Array.isArray(priorPayload.manual_filing_audit_events)
        ? (priorPayload.manual_filing_audit_events as unknown[])
        : []),
      audit_event_payload,
    ],
  };

  const updateRow: Record<string, unknown> = {
    status: newDbStatus,
    submission_id: caseId || null,
    source_payload: nextPayload,
    updated_at: new Date().toISOString(),
  };

  const { error: updateErr } = await client
    .from("claim_submissions")
    .update(updateRow)
    .eq("organization_id", organizationId)
    .eq("id", body.claim_submission_id);

  if (updateErr) {
    return {
      ok: false,
      blocked: false,
      blockReason: updateErr.message,
      approvalKey: MANUAL_FILING_WRITE_APPROVAL_KEY,
      written: false,
      dryRunPreview: preview,
      audit_event_payload,
      duplicate_external_case_id_rule: DUPLICATE_EXTERNAL_CASE_ID_RULE,
      before,
      after: null,
    };
  }

  try {
    await client.from("claim_history_logs").insert({
      organization_id: organizationId,
      submission_id: body.claim_submission_id,
      actor: "human_admin",
      message_content: `Manual filing recorded (case ${caseId || "pending external id"}) — not submitted by MENORIX.`,
      attachments: { audit_event: audit_event_payload },
      status_at_time: newDbStatus,
      message_kind: "note",
    });
  } catch {
    // claim_history_logs optional — audit retained in source_payload
  }

  return {
    ok: true,
    blocked: false,
    blockReason: null,
    approvalKey: MANUAL_FILING_WRITE_APPROVAL_KEY,
    written: true,
    dryRunPreview: preview,
    audit_event_payload,
    duplicate_external_case_id_rule: DUPLICATE_EXTERNAL_CASE_ID_RULE,
    before,
    after: {
      status: newDbStatus,
      submission_id: caseId || null,
    },
  };
}
