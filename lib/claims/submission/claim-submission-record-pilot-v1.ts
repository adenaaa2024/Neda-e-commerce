/**
 * PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1
 * Controlled INSERT of claim_submissions for trusted open pilot cases (manual filing tracking only).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClaimFilingPacketPreviewV1 } from "../filing/claim-filing-packet-preview-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import {
  buildDraftArtifactPaths,
  buildHandoffReferenceGraph,
  PILOT_DRAFT_EXPORT_RUN_ID,
  type DraftArtifactPaths,
} from "./claim-manual-filing-handoff-ui-contract";
import {
  assessManualFilingCase,
  type ManualFilingReadinessState,
} from "./claim-submission-manual-filing-contract-v1";

export const CLAIM_SUBMISSION_RECORD_PILOT_V1_VERSION =
  "claim-submission-record-pilot-v1" as const;

export const SUBMISSION_RECORD_PILOT_ORIGIN = "manual_filing_record_pilot_v1" as const;

export const SUBMISSION_RECORD_APPROVAL_TOKEN = "APPROVED_CLAIM_SUBMISSION_RECORD_PILOT_V1" as const;

export const SCHEMA_MIGRATION_APPROVAL_TOKEN = "APPROVED_CLAIM_SUBMISSIONS_SCHEMA_MIGRATION_V1" as const;

export const SUBMISSION_RECORD_APPROVAL_PATH =
  ".cursor/operator-approvals/claim-submission-record-pilot-v1-approval.md" as const;

export const HANDOFF_VERIFY_PATH =
  ".cursor/audit-reports/phase-claim-manual-filing-handoff-preview-v1/20260616T120000Z/results.json" as const;

export const TRID_VERIFY_PATH =
  ".cursor/audit-reports/phase-claim-trid-reference-graph-final-verify-v1/20260616T110000Z/results.json" as const;

export const TRID_REVERIFY_AFTER_7H_PATH =
  ".cursor/audit-reports/phase-claim-trid-reference-graph-reverify-after-7h-v1/20260616T140000Z/results.json" as const;

const ACTIVE_STATUSES = new Set([
  "draft",
  "ready_to_send",
  "submitted",
  "investigating",
  "evidence_requested",
  "accepted",
]);

export type SubmissionRecordPilotRow = {
  organization_id: string;
  store_id: string;
  claim_case_id: string;
  return_id: null;
  status: "draft" | "ready_to_send";
  submission_id: null;
  report_url: null;
  source_payload: Record<string, unknown>;
};

export type ExistingPilotSubmission = {
  id: string;
  claim_case_id: string | null;
  return_id: string | null;
  status: string | null;
  submission_id: string | null;
  source_payload: Record<string, unknown> | null;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function buildSubmissionIdempotencyKey(claimCaseId: string, pilotCaseRunId: string): string {
  return `manual-filing-v1:${claimCaseId}:${pilotCaseRunId}`;
}

export function resolveSubmissionStatus(
  readiness: ManualFilingReadinessState,
): "draft" | "ready_to_send" {
  return readiness === "ready_for_manual_filing" ? "ready_to_send" : "draft";
}

export function buildSubmissionRecordSourcePayload(args: {
  preview: ClaimFilingPacketPreviewV1;
  pilotCaseRunId: string;
  intakeRunId: string;
  submissionRecordRunId: string;
  tridGraphVerified: string;
  referenceGraph: ReturnType<typeof buildHandoffReferenceGraph>;
  exportRunId?: string;
  draftArtifactPaths?: DraftArtifactPaths;
}): Record<string, unknown> {
  const assessment = assessManualFilingCase({ preview: args.preview, caseMetadata: {} });
  const exportRunId = str(args.exportRunId) || PILOT_DRAFT_EXPORT_RUN_ID;
  const artifacts =
    args.draftArtifactPaths ??
    buildDraftArtifactPaths({
      claimCaseId: args.preview.claim_case_id,
      familyKeyV3: args.preview.family_key_v3,
      sourceEventKey: args.preview.source_event_key,
      exportRunId,
    });

  return {
    claim_case_id: args.preview.claim_case_id,
    submission_mode: "manual_filing",
    idempotency_key: buildSubmissionIdempotencyKey(args.preview.claim_case_id, args.pilotCaseRunId),
    export_run_id: exportRunId,
    draft_artifact_paths: artifacts,
    warnings: args.preview.warnings,
    blockers: args.preview.blockers,
    trid_reference_graph_verification: {
      SAFE_TRID_REFERENCE_GRAPH_VERIFIED: args.tridGraphVerified,
      trid_reference: args.referenceGraph.trid_reference,
      tracking_reference: args.referenceGraph.tracking_reference,
      missing_trid_warning: args.referenceGraph.missing_trid_warning,
      reference_graph_lines: args.referenceGraph.lines,
    },
    money_lanes: args.preview.money_lanes,
    not_submitted_to_amazon: true,
    pilot_case_run_id: args.pilotCaseRunId,
    intake_run_id: args.intakeRunId,
    submission_record_origin: SUBMISSION_RECORD_PILOT_ORIGIN,
    submission_record_run_id: args.submissionRecordRunId,
    operator_review_required: true,
    family_key_v3: args.preview.family_key_v3,
    source_event_key: args.preview.source_event_key,
    readiness_state: assessment.readiness_state,
    filing_packet_preview_id: args.preview.filing_packet_preview_id,
  };
}

export function buildSubmissionRecordRow(args: {
  organizationId: string;
  storeId: string;
  preview: ClaimFilingPacketPreviewV1;
  pilotCaseRunId: string;
  intakeRunId: string;
  submissionRecordRunId: string;
  tridGraphVerified: string;
  referenceGraph: ReturnType<typeof buildHandoffReferenceGraph>;
  exportRunId?: string;
  draftArtifactPaths?: DraftArtifactPaths;
}): SubmissionRecordPilotRow {
  const assessment = assessManualFilingCase({ preview: args.preview, caseMetadata: {} });
  return {
    organization_id: args.organizationId,
    store_id: args.storeId,
    claim_case_id: args.preview.claim_case_id,
    return_id: null,
    status: resolveSubmissionStatus(assessment.readiness_state),
    submission_id: null,
    report_url: null,
    source_payload: buildSubmissionRecordSourcePayload(args),
  };
}

export function isActivePilotSubmission(row: ExistingPilotSubmission): boolean {
  const status = str(row.status).toLowerCase();
  return ACTIVE_STATUSES.has(status);
}

export function extractClaimCaseIdFromSubmission(row: ExistingPilotSubmission): string | null {
  if (row.claim_case_id) return str(row.claim_case_id);
  const payload = metaRecord(row.source_payload);
  return str(payload.claim_case_id) || null;
}

export async function loadExistingPilotSubmissions(
  client: SupabaseClient,
  organizationId: string,
  options?: { includeClaimCaseId?: boolean },
): Promise<ExistingPilotSubmission[]> {
  const withCaseCol = options?.includeClaimCaseId !== false;
  const selectCols = withCaseCol
    ? "id, claim_case_id, return_id, status, submission_id, source_payload"
    : "id, return_id, status, submission_id, source_payload";
  const { data, error } = await client
    .from("claim_submissions")
    .select(selectCols)
    .eq("organization_id", organizationId);
  if (error) {
    if (withCaseCol && String(error.message).includes("claim_case_id")) {
      return loadExistingPilotSubmissions(client, organizationId, { includeClaimCaseId: false });
    }
    throw new Error(`claim_submissions load: ${error.message}`);
  }
  return (data ?? []).map((row) => {
    const r = row as unknown as Record<string, unknown>;
    return {
      id: str(r.id),
      claim_case_id: withCaseCol ? str(r.claim_case_id) || null : null,
      return_id: str(r.return_id) || null,
      status: str(r.status) || null,
      submission_id: str(r.submission_id) || null,
      source_payload: metaRecord(r.source_payload),
    };
  });
}

export function findActiveSubmissionForCase(
  existing: ExistingPilotSubmission[],
  claimCaseId: string,
): ExistingPilotSubmission | null {
  for (const row of existing) {
    const cid = extractClaimCaseIdFromSubmission(row);
    if (cid === claimCaseId && isActivePilotSubmission(row)) return row;
  }
  return null;
}

export function buildSubmissionRecordPilotRollbackSql(args: {
  organizationId: string;
  submissionRecordRunId: string;
}): string {
  return `-- PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1 rollback (soft-cancel; no hard delete)
-- Scope: submission_record_origin = '${SUBMISSION_RECORD_PILOT_ORIGIN}'
--        submission_record_run_id = '${args.submissionRecordRunId}'
UPDATE public.claim_submissions
SET
  status = 'rejected',
  source_payload = COALESCE(source_payload, '{}'::jsonb) || jsonb_build_object(
    'soft_cancelled_at', now()::text,
    'soft_cancel_reason', 'pilot_submission_record_rollback',
    'pilot_rollback_run_id', '${args.submissionRecordRunId}'
  ),
  updated_at = now()
WHERE organization_id = '${args.organizationId}'::uuid
  AND source_payload->>'submission_record_origin' = '${SUBMISSION_RECORD_PILOT_ORIGIN}'
  AND source_payload->>'submission_record_run_id' = '${args.submissionRecordRunId}'
  AND status NOT IN ('rejected');
`;
}

export function readSubmissionRecordApprovalStatus(approvalPath: string, raw: string): {
  approved: boolean;
  schemaMigrationApproved: boolean;
  raw: string;
  schemaMigrationRaw: string;
} {
  const approved = /^APPROVED_CLAIM_SUBMISSION_RECORD_PILOT_V1\s*=\s*yes\s*$/im.test(raw);
  const schemaMigrationApproved =
    /^APPROVED_CLAIM_SUBMISSIONS_SCHEMA_MIGRATION_V1\s*=\s*yes\s*$/im.test(raw);
  return {
    approved,
    schemaMigrationApproved,
    raw: approved ? "yes" : "no_or_missing",
    schemaMigrationRaw: schemaMigrationApproved ? "yes" : "no_or_missing",
  };
}

export const SUBMISSION_RECORD_PILOT_DEFAULTS = {
  pilot_case_run_id: PILOT_CASE_RUN_ID,
  intake_run_id: PILOT_INTAKE_RUN_ID,
  export_run_id: PILOT_DRAFT_EXPORT_RUN_ID,
} as const;
