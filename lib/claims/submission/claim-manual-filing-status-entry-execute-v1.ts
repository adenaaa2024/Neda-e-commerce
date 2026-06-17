/**
 * PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1
 * Guarded batch execute for pilot manual filing status records — no Amazon API.
 */
import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import {
  attemptGuardedManualFilingExecuteV1,
  checkDuplicateExternalCaseIdV1,
  type ManualFilingExecuteResult,
} from "./claim-manual-filing-status-entry-guarded-execute-v1";
import {
  MANUAL_FILING_WRITE_APPROVAL_KEY,
  readManualFilingWriteApprovalStatus,
  verifyManualFilingUiIntegrationStatic,
} from "./claim-manual-filing-status-entry-ui-and-guarded-execute-v1";
import { snapshotPilotSubmissions } from "./claim-manual-filing-status-entry-plan-v1";
import { composeReimbursementTrackingPreviewV1 } from "./claim-reimbursement-tracking-preview-v1";
import { verifyCogsWritePrerequisites } from "./claim-money-lane-preview-after-cogs-v1";

export const MANUAL_FILING_STATUS_ENTRY_EXECUTE_V1 = {
  phase: "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1",
  pilotCaseRunId: PILOT_CASE_RUN_ID,
  intakeRunId: PILOT_INTAKE_RUN_ID,
  defaultInputPath: ".cursor/operator-approvals/manual-filing-status-entry-execute-v1-input.json",
} as const;

export type ManualFilingExecuteInputRowV1 = {
  claim_submission_id: string;
  amazon_case_id: string;
  filed_at: string;
  filed_by?: string;
  amazon_case_url?: string;
  filing_notes?: string;
  operator_already_filed_in_seller_central: boolean;
};

export type ManualFilingExecuteInputFileV1 = {
  input_source: "operator_ui_export" | "manual_json";
  filed_by: string;
  accept_cogs_missing?: boolean;
  entries: ManualFilingExecuteInputRowV1[];
};

export type ManualFilingExecuteSnapshotV1 = {
  claim_submissions_count: number;
  claim_cases_count: number;
  claim_lines_count: number;
  claim_candidates_count: number;
  pilot_submission_count: number;
  legacy_submission_count: number;
  pilot_status_breakdown: Record<string, number>;
  legacy_submission_ids: string[];
};

export type PerSubmissionStatusMatrixRow = {
  claim_submission_id: string;
  claim_case_id: string;
  family: string | null;
  is_pilot: boolean;
  is_legacy: boolean;
  old_status: string | null;
  new_status: string | null;
  external_case_id: string | null;
  tracking_status: string | null;
  execute_action: "updated" | "skipped" | "rejected" | "pending";
  skip_reason: string | null;
};

export type ManualFilingExecutePrerequisites = {
  reimbursement_tracking_ui_ready: boolean;
  manual_filing_ui_plan_pass: boolean;
  SAFE_REIMBURSEMENT_TRACKING_UI_READY: boolean;
  SAFE_TO_EXECUTE_MANUAL_FILING_STATUS_ENTRY: boolean;
  cogs_write_complete: boolean;
  cogs_missing_accepted: boolean;
  block_reason: string | null;
};

export type ManualFilingBatchExecuteResultV1 = {
  phase: string;
  execute_run_id: string;
  approval_status: ReturnType<typeof readManualFilingWriteApprovalStatus>;
  prerequisites: ManualFilingExecutePrerequisites;
  selected_submission_count: number;
  updated_submission_count: number;
  skipped_count: number;
  skip_reasons: Array<{ claim_submission_id: string; reason: string }>;
  before_snapshot: ManualFilingExecuteSnapshotV1;
  after_snapshot: ManualFilingExecuteSnapshotV1 | null;
  per_submission_status_matrix: PerSubmissionStatusMatrixRow[];
  external_case_id_storage_verification: boolean;
  audit_event_verification: boolean;
  duplicate_external_case_id_verification: boolean;
  legacy_submissions_untouched_verification: boolean;
  executed: boolean;
  SAFE_MANUAL_FILING_STATUS_ENTRY_EXECUTED: boolean;
  SAFE_CLAIM_PILOT_READY_FOR_FINAL_VERIFY: boolean;
  NEXT_PROMPT: string;
  execute_results: ManualFilingExecuteResult[];
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function loadManualFilingExecuteInputFile(
  relativePath = MANUAL_FILING_STATUS_ENTRY_EXECUTE_V1.defaultInputPath,
): ManualFilingExecuteInputFileV1 {
  const full = path.join(process.cwd(), relativePath);
  const raw = JSON.parse(fs.readFileSync(full, "utf8")) as ManualFilingExecuteInputFileV1;
  if (!Array.isArray(raw.entries)) throw new Error("entries must be an array");
  return raw;
}

async function loadExecuteSnapshot(
  client: SupabaseClient,
  organizationId: string,
): Promise<ManualFilingExecuteSnapshotV1> {
  const [subs, cases, lines, cands, allRows] = await Promise.all([
    client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client
      .from("claim_submissions")
      .select("id, status, submission_id, source_payload")
      .eq("organization_id", organizationId),
  ]);

  const rows = (allRows.data ?? []) as Array<{
    id: string;
    status?: string | null;
    submission_id?: string | null;
    source_payload?: Record<string, unknown> | null;
  }>;

  const pilot = rows.filter((r) => str(r.source_payload?.pilot_case_run_id) === PILOT_CASE_RUN_ID);
  const legacy = rows.filter(
    (r) =>
      str(r.source_payload?.pilot_case_run_id) !== PILOT_CASE_RUN_ID &&
      str(r.source_payload?.submission_record_origin) !== "manual_filing_record_pilot_v1",
  );

  return {
    claim_submissions_count: subs.count ?? 0,
    claim_cases_count: cases.count ?? 0,
    claim_lines_count: lines.count ?? 0,
    claim_candidates_count: cands.count ?? 0,
    pilot_submission_count: pilot.length,
    legacy_submission_count: legacy.length,
    pilot_status_breakdown: pilot.reduce<Record<string, number>>((acc, r) => {
      const k = str(r.status) || "unknown";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    legacy_submission_ids: legacy.map((r) => r.id),
  };
}

export async function verifyManualFilingExecutePrerequisites(args: {
  client: SupabaseClient;
  organizationId: string;
  acceptCogsMissing?: boolean;
}): Promise<ManualFilingExecutePrerequisites> {
  const ui = verifyManualFilingUiIntegrationStatic();
  const uiReady = Object.values(ui).every(Boolean);
  const cogs = await verifyCogsWritePrerequisites(args.client, args.organizationId);
  const pilotSnap = await snapshotPilotSubmissions(args.client, args.organizationId);
  const cogsMissingAccepted = args.acceptCogsMissing === true;
  const moneyLaneReady = cogs.SAFE_TO_REBUILD_MONEY_LANE_PREVIEW_WITH_COGS || cogsMissingAccepted;
  const pilotOk = Number(pilotSnap.pilot_count) === 10;

  let block_reason: string | null = null;
  if (!uiReady) block_reason = "Manual filing UI integration static verify failed";
  else if (!pilotOk) block_reason = `Expected 10 pilot submissions, found ${pilotSnap.pilot_count}`;
  else if (!moneyLaneReady) {
    block_reason =
      "COGS not applied — set accept_cogs_missing=true in input after operator accepts COGS_MISSING warning, or complete PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1";
  }

  const safeToExecute = uiReady && pilotOk && moneyLaneReady;

  return {
    reimbursement_tracking_ui_ready: uiReady,
    manual_filing_ui_plan_pass: uiReady,
    SAFE_REIMBURSEMENT_TRACKING_UI_READY: uiReady,
    SAFE_TO_EXECUTE_MANUAL_FILING_STATUS_ENTRY: safeToExecute,
    cogs_write_complete: cogs.SAFE_PRODUCT_COGS_WRITE_COMPLETE,
    cogs_missing_accepted: cogsMissingAccepted,
    block_reason,
  };
}

function isLegacyRow(sourcePayload: Record<string, unknown> | null | undefined): boolean {
  const p = metaRecord(sourcePayload);
  return (
    str(p.pilot_case_run_id) !== PILOT_CASE_RUN_ID &&
    str(p.submission_record_origin) !== "manual_filing_record_pilot_v1"
  );
}

export async function runManualFilingStatusEntryExecuteV1(args: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  executeRunId: string;
  input: ManualFilingExecuteInputFileV1;
  execute: boolean;
  actorId?: string | null;
}): Promise<ManualFilingBatchExecuteResultV1> {
  const approval = readManualFilingWriteApprovalStatus();
  const prerequisites = await verifyManualFilingExecutePrerequisites({
    client: args.client,
    organizationId: args.organizationId,
    acceptCogsMissing: args.input.accept_cogs_missing === true,
  });

  const before = await loadExecuteSnapshot(args.client, args.organizationId);
  const composed = await composeReimbursementTrackingPreviewV1(args.client, args.organizationId, args.storeId, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  const previewById = new Map(composed.previews.map((p) => [p.claim_submission_id, p]));
  const skip_reasons: Array<{ claim_submission_id: string; reason: string }> = [];
  const execute_results: ManualFilingExecuteResult[] = [];
  let updated_submission_count = 0;

  const selectedIds = new Set(args.input.entries.map((e) => str(e.claim_submission_id)));
  const canExecute =
    args.execute &&
    approval.write_enabled &&
    prerequisites.SAFE_TO_EXECUTE_MANUAL_FILING_STATUS_ENTRY &&
    args.input.entries.length > 0;

  for (const entry of args.input.entries) {
    const sid = str(entry.claim_submission_id);
    if (!sid) {
      skip_reasons.push({ claim_submission_id: sid || "(empty)", reason: "claim_submission_id required" });
      continue;
    }
    if (!previewById.has(sid)) {
      skip_reasons.push({ claim_submission_id: sid, reason: "Not in pilot scope or legacy row excluded" });
      continue;
    }
    if (!entry.operator_already_filed_in_seller_central) {
      skip_reasons.push({
        claim_submission_id: sid,
        reason: "operator_already_filed_in_seller_central must be true",
      });
      continue;
    }
    if (!str(entry.amazon_case_id) || !str(entry.filed_at) || !str(entry.filed_by ?? args.input.filed_by)) {
      skip_reasons.push({
        claim_submission_id: sid,
        reason: "amazon_case_id, filed_at, and filed_by required",
      });
      continue;
    }

    if (!canExecute) {
      skip_reasons.push({
        claim_submission_id: sid,
        reason: !approval.write_enabled
          ? `${MANUAL_FILING_WRITE_APPROVAL_KEY}=yes required`
          : !prerequisites.SAFE_TO_EXECUTE_MANUAL_FILING_STATUS_ENTRY
            ? prerequisites.block_reason ?? "Prerequisites not met"
            : "Execute flag not set or empty batch blocked",
      });
      continue;
    }

    const dup = await checkDuplicateExternalCaseIdV1({
      client: args.client,
      organizationId: args.organizationId,
      storeId: args.storeId,
      externalCaseId: str(entry.amazon_case_id),
      excludeSubmissionId: sid,
    });
    if (dup.duplicate) {
      skip_reasons.push({
        claim_submission_id: sid,
        reason: `Duplicate external_case_id (conflict ${dup.conflictingSubmissionId})`,
      });
      continue;
    }

    const result = await attemptGuardedManualFilingExecuteV1(
      args.client,
      args.organizationId,
      args.storeId,
      {
        claim_submission_id: sid,
        amazon_case_id: str(entry.amazon_case_id),
        filed_at: str(entry.filed_at),
        amazon_case_url: str(entry.amazon_case_url),
        filing_notes: str(entry.filing_notes),
        attestation: entry.operator_already_filed_in_seller_central === true,
        pilot_case_run_id: PILOT_CASE_RUN_ID,
        intake_run_id: PILOT_INTAKE_RUN_ID,
        execute_run_id: args.executeRunId,
      },
      str(entry.filed_by ?? args.input.filed_by) || args.actorId || null,
    );
    execute_results.push(result);

    if (result.written) updated_submission_count += 1;
    else {
      skip_reasons.push({
        claim_submission_id: sid,
        reason: result.blockReason ?? "Execute failed",
      });
    }
  }

  const after = canExecute ? await loadExecuteSnapshot(args.client, args.organizationId) : null;

  const { data: allRows } = await args.client
    .from("claim_submissions")
    .select("id, status, submission_id, source_payload")
    .eq("organization_id", args.organizationId);

  const rowById = new Map(
    ((allRows ?? []) as Array<{
      id: string;
      status?: string | null;
      submission_id?: string | null;
      source_payload?: Record<string, unknown> | null;
    }>).map((r) => [r.id, r]),
  );

  const per_submission_status_matrix: PerSubmissionStatusMatrixRow[] = composed.previews.map((p) => {
    const dbRow = rowById.get(p.claim_submission_id);
    const payload = metaRecord(dbRow?.source_payload);
    const isPilot = str(payload.pilot_case_run_id) === PILOT_CASE_RUN_ID;
    const isLegacy = isLegacyRow(payload);
    const wasSelected = selectedIds.has(p.claim_submission_id);
    const wasUpdated = execute_results.some(
      (r) => r.written && r.dryRunPreview?.claim_submission_id === p.claim_submission_id,
    );
    const skip = skip_reasons.find((s) => s.claim_submission_id === p.claim_submission_id);

    let execute_action: PerSubmissionStatusMatrixRow["execute_action"] = "pending";
    if (wasUpdated) execute_action = "updated";
    else if (skip && wasSelected) execute_action = "rejected";
    else if (!wasSelected) execute_action = "skipped";

    return {
      claim_submission_id: p.claim_submission_id,
      claim_case_id: p.claim_case_id,
      family: p.claim_family,
      is_pilot: isPilot,
      is_legacy: isLegacy,
      old_status: str(dbRow?.status) || null,
      new_status: wasUpdated ? "submitted" : str(dbRow?.status) || null,
      external_case_id: str(dbRow?.submission_id) || null,
      tracking_status: str(payload.manual_filing_tracking_status) || null,
      execute_action,
      skip_reason: skip?.reason ?? (wasSelected ? null : "Not selected in operator input"),
    };
  });

  const legacyUntouched =
    after == null
      ? true
      : before.legacy_submission_ids.every((id) => {
          const beforeRow = rowById.get(id);
          return beforeRow != null;
        }) &&
        execute_results.every((r) => {
          const sid = r.dryRunPreview?.claim_submission_id;
          return !sid || !before.legacy_submission_ids.includes(sid);
        });

  const externalCaseOk =
    updated_submission_count === 0
      ? true
      : execute_results
          .filter((r) => r.written)
          .every((r) => !!str(r.after?.submission_id));

  const auditOk =
    updated_submission_count === 0
      ? true
      : execute_results
          .filter((r) => r.written)
          .every((r) => r.audit_event_payload != null && str(r.audit_event_payload.event_type).length > 0);

  const duplicateRuleOk = execute_results.every((r) => !r.blockReason?.includes("Duplicate external case ID"));

  const executed = canExecute && updated_submission_count > 0;
  const safeExecuted =
    executed &&
    externalCaseOk &&
    auditOk &&
    legacyUntouched &&
    (after?.claim_submissions_count ?? before.claim_submissions_count) === before.claim_submissions_count;

  return {
    phase: MANUAL_FILING_STATUS_ENTRY_EXECUTE_V1.phase,
    execute_run_id: args.executeRunId,
    approval_status: approval,
    prerequisites,
    selected_submission_count: args.input.entries.length,
    updated_submission_count,
    skipped_count: args.input.entries.length - updated_submission_count,
    skip_reasons,
    before_snapshot: before,
    after_snapshot: after,
    per_submission_status_matrix,
    external_case_id_storage_verification: externalCaseOk,
    audit_event_verification: auditOk,
    duplicate_external_case_id_verification: duplicateRuleOk,
    legacy_submissions_untouched_verification: legacyUntouched,
    executed,
    SAFE_MANUAL_FILING_STATUS_ENTRY_EXECUTED: safeExecuted,
    SAFE_CLAIM_PILOT_READY_FOR_FINAL_VERIFY:
      safeExecuted &&
      per_submission_status_matrix
        .filter((r) => r.is_pilot)
        .every((r) => !!str(r.external_case_id)),
    NEXT_PROMPT: !approval.write_enabled
      ? `Set ${MANUAL_FILING_WRITE_APPROVAL_KEY}=yes and fill operator input JSON; re-run with --execute`
      : !prerequisites.SAFE_TO_EXECUTE_MANUAL_FILING_STATUS_ENTRY
        ? prerequisites.block_reason ??
          "Complete COGS execute or set accept_cogs_missing in input; then re-run execute"
        : executed
          ? "PHASE-CLAIM-PILOT-FINAL-VERIFY-V1 — refresh reimbursement tracking; verify observed reimbursement matching"
          : "Fill manual-filing-status-entry-execute-v1-input.json with pilot submission filing records; re-run with --execute",
    execute_results,
  };
}

export function verifyManualFilingExecuteContractStatic(): boolean {
  const p = path.join(process.cwd(), "lib/claims/submission/claim-manual-filing-status-entry-guarded-execute-v1.ts");
  const src = fs.readFileSync(p, "utf8");
  return (
    src.includes("attemptGuardedManualFilingExecuteV1") &&
    src.includes("not_submitted_to_amazon") &&
    !src.includes("amazon-sp-api")
  );
}
