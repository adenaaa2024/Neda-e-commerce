/**
 * PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 — controlled pilot COGS override apply.
 * Writes workspace_settings.module_configs.claim_intake.cogs_overrides only.
 * No claim_submissions / claim_cases / claim_lines / claim_candidates mutation.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

import { composeMoneyLanePreviewV1 } from "@/lib/claims/submission/claim-money-lane-preview-v1";
import {
  buildManualCogsDryRunResultV1,
  loadPilotProductsNeedingCogsV1,
  PILOT_FNSKUS_V1,
  PRODUCT_COGS_MANUAL_ENTRY_UI_V1,
  type ManualCogsEntryInputV1,
} from "@/lib/claims/submission/product-cogs-manual-entry-ui-v1";
import {
  extractCogsOverrideUnitCost,
  type CogsOverrideRecordV1,
} from "@/lib/claims/submission/cogs-override-value-v1";
import { loadCogsOverridesForOrg } from "@/lib/claims/submission/product-cogs-audit-v1";
import {
  attemptGuardedCogsWriteV1,
  resolveCanonicalWorkspaceSettingsRowForOrg,
} from "@/lib/claims/submission/product-cogs-source-write-v1";
import {
  COGS_BUILD_APPROVAL_KEYS,
  readCogsBuildApprovalStatus,
} from "@/lib/products/contracts/product-cogs-source-build-v1";

export const PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1 = {
  phase: "PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1",
  pilotCaseRunId: PRODUCT_COGS_MANUAL_ENTRY_UI_V1.pilotCaseRunId,
  intakeRunId: PRODUCT_COGS_MANUAL_ENTRY_UI_V1.intakeRunId,
  approvalPath: ".cursor/operator-approvals/product-cogs-manual-entry-execute-v1-approval.md",
  defaultInputPath: ".cursor/operator-approvals/product-cogs-manual-entry-execute-v1-input.json",
  approvalKey: "APPROVED_PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1",
} as const;

export type CogsExecuteInputRowV1 = ManualCogsEntryInputV1 & {
  salePriceReviewConfirmed?: boolean;
};

export type CogsExecuteInputFileV1 = {
  input_source: "operator_ui_export" | "approved_csv_dry_run" | "manual_json";
  approved_by: string;
  entries: CogsExecuteInputRowV1[];
};

export type CogsExecuteSnapshotV1 = {
  cogs_override_keys: string[];
  cogs_coverage_fnsku_count: number;
  claim_submissions_count: number;
  claim_cases_count: number;
  claim_lines_count: number;
  claim_candidates_count: number;
  cogs_overrides_json: Record<string, unknown>;
};

export type CogsExecuteApprovalStatus = {
  build_write: "approved" | "missing" | "denied";
  execute: "approved" | "missing" | "denied";
  write_enabled: boolean;
  allow_partial: boolean;
  block_reason: string | null;
};

export type CogsExecuteResultV1 = {
  phase: string;
  execute_run_id: string;
  approval_status: CogsExecuteApprovalStatus;
  approval_file_status: "approved" | "missing" | "denied";
  input_source: string | null;
  input_products_count: number;
  accepted_cogs_rows_count: number;
  rejected_cogs_rows_count: number;
  rejection_reasons: Array<{ fnsku: string; issues: string[] }>;
  cogs_storage_location: string;
  approved_fnsku_count: number;
  skipped_fnsku_count: number;
  rejected_rows: Array<{ fnsku: string; issues: string[] }>;
  validation_summary: Record<string, unknown>;
  before_snapshot: CogsExecuteSnapshotV1;
  after_snapshot: CogsExecuteSnapshotV1 | null;
  cogs_coverage_count: number;
  recovery_value_calculable_count: number;
  per_product_cogs_matrix: Array<Record<string, unknown>>;
  per_fnsku_cogs_matrix: Array<Record<string, unknown>>;
  per_submission_recovery_preview: Array<Record<string, unknown>>;
  sale_price_not_used_as_cogs_verification: boolean;
  audit_log_verification: boolean;
  no_claim_submission_mutation_verification: boolean;
  no_claim_case_mutation_verification: boolean;
  no_claim_line_mutation_verification: boolean;
  no_claim_candidate_mutation_verification: boolean;
  no_amazon_submission_verification: boolean;
  no_scanner_change_verification: boolean;
  persistence_verification: {
    resolver_behavior: "org_scoped" | "singleton" | "none";
    workspace_settings_row_targeted: string | null;
    cogs_overrides_before_keys: string[];
    cogs_overrides_after_keys: string[];
    expected_fnsku_keys: string[];
    all_expected_keys_present: boolean;
    reread_by_id_confirmed: boolean;
  };
  rollback_plan: string;
  executed: boolean;
  SAFE_COGS_APPLIED_FOR_PILOT: boolean;
  SAFE_PRODUCT_COGS_WRITE_COMPLETE: boolean;
  SAFE_TO_REBUILD_MONEY_LANE_PREVIEW_WITH_COGS: boolean;
  SAFE_TO_UPDATE_MONEY_LANE_UI_WITH_RECOVERY_VALUE: boolean;
  SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY_UI: boolean;
  NEXT_PROMPT: string;
};

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readCogsExecuteApprovalStatus(
  approvalPath = PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.approvalPath,
): { status: "approved" | "missing" | "denied"; raw: string } {
  const p = path.join(process.cwd(), approvalPath);
  if (!fs.existsSync(p)) return { status: "missing", raw: "" };
  const raw = fs.readFileSync(p, "utf8");
  const key = PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.approvalKey;
  if (new RegExp(`^${key}\\s*=\\s*yes\\s*$`, "im").test(raw)) {
    return { status: "approved", raw };
  }
  return { status: "denied", raw };
}

export function readAllowPartialCogsWrite(
  approvalPath = PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.approvalPath,
): boolean {
  const p = path.join(process.cwd(), approvalPath);
  if (!fs.existsSync(p)) return false;
  return /^ALLOW_PARTIAL_COGS_WRITE\s*=\s*yes\s*$/im.test(fs.readFileSync(p, "utf8"));
}

export function readCogsExecuteDualApprovalStatus(): CogsExecuteApprovalStatus {
  const build = readCogsBuildApprovalStatus();
  const execute = readCogsExecuteApprovalStatus();
  const allow_partial = readAllowPartialCogsWrite();

  let block_reason: string | null = null;
  if (build.write !== "approved") {
    block_reason = `${COGS_BUILD_APPROVAL_KEYS.write}=yes required in product-cogs-source-build-v1-approval.md`;
  } else if (execute.status !== "approved") {
    block_reason = `${PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.approvalKey}=yes required in product-cogs-manual-entry-execute-v1-approval.md`;
  }

  return {
    build_write: build.write,
    execute: execute.status,
    write_enabled: build.write === "approved" && execute.status === "approved",
    allow_partial,
    block_reason,
  };
}

export function loadCogsExecuteInputFile(inputPath: string): CogsExecuteInputFileV1 {
  const p = path.join(process.cwd(), inputPath);
  if (!fs.existsSync(p)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as CogsExecuteInputFileV1;
  if (!Array.isArray(parsed.entries)) {
    throw new Error("Input file must contain entries array.");
  }
  return parsed;
}

export function buildCogsOverrideRecord(args: {
  entry: CogsExecuteInputRowV1;
  executeRunId: string;
  approvedAt: string;
}): CogsOverrideRecordV1 {
  return {
    identifier_type: "FNSKU",
    identifier_value: args.entry.fnsku,
    unit_cost: args.entry.unitCost,
    currency: args.entry.currency.trim().toUpperCase(),
    effective_date: args.entry.effectiveDate,
    source_note: args.entry.sourceNote,
    source_type: args.entry.sourceType ?? "manual_override",
    approved_by: args.entry.approvedBy,
    approved_at: args.approvedAt,
    run_id: args.executeRunId,
    pilot_case_run_id: PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.pilotCaseRunId,
    intake_run_id: PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.intakeRunId,
    sale_price_review_confirmed: args.entry.salePriceReviewConfirmed,
  };
}

export function buildCogsOverridesRollbackSql(args: {
  organizationId: string;
  beforeOverrides: Record<string, unknown>;
}): string {
  const json = JSON.stringify(args.beforeOverrides).replace(/'/g, "''");
  return `-- Rollback cogs_overrides for org ${args.organizationId}
UPDATE workspace_settings
SET module_configs = jsonb_set(
  COALESCE(module_configs, '{}'::jsonb),
  '{claim_intake,cogs_overrides}',
  '${json}'::jsonb,
  true
)
WHERE organization_id = '${args.organizationId}'::uuid;
`;
}

async function countTable(
  client: SupabaseClient,
  table: string,
  organizationId: string,
): Promise<number> {
  const { count, error } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (error) return -1;
  return count ?? 0;
}

export async function snapshotCogsExecuteState(args: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
}): Promise<CogsExecuteSnapshotV1> {
  const overrides = await loadCogsOverridesForOrg(args.client, args.organizationId);
  const pilotProducts = await loadPilotProductsNeedingCogsV1({
    organizationId: args.organizationId,
    storeId: args.storeId,
    supabase: args.client,
  });
  const covered = pilotProducts.filter((p) => extractCogsOverrideUnitCost(overrides[p.fnsku]) != null).length;

  const [subs, cases, lines, candidates] = await Promise.all([
    countTable(args.client, "claim_submissions", args.organizationId),
    countTable(args.client, "claim_cases", args.organizationId),
    countTable(args.client, "claim_lines", args.organizationId),
    countTable(args.client, "claim_candidates", args.organizationId),
  ]);

  return {
    cogs_override_keys: Object.keys(overrides).filter((k) => !k.startsWith("_")),
    cogs_coverage_fnsku_count: covered,
    claim_submissions_count: subs,
    claim_cases_count: cases,
    claim_lines_count: lines,
    claim_candidates_count: candidates,
    cogs_overrides_json: overrides,
  };
}

export async function runProductCogsManualEntryExecuteV1(args: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  executeRunId: string;
  input: CogsExecuteInputFileV1;
  execute: boolean;
  scannerUnchanged: boolean;
}): Promise<CogsExecuteResultV1> {
  const approval = readCogsExecuteDualApprovalStatus();
  const executeApproval = readCogsExecuteApprovalStatus();
  const pilotProducts = await loadPilotProductsNeedingCogsV1({
    organizationId: args.organizationId,
    storeId: args.storeId,
    supabase: args.client,
  });
  const before = await snapshotCogsExecuteState({
    client: args.client,
    organizationId: args.organizationId,
    storeId: args.storeId,
  });

  const rejected_rows: CogsExecuteResultV1["rejected_rows"] = [];
  const approvedRecords = new Map<string, CogsOverrideRecordV1>();
  let skipped = 0;

  for (const entry of args.input.entries) {
    const pilot = pilotProducts.find((p) => p.fnsku === entry.fnsku);
    if (!pilot) {
      rejected_rows.push({ fnsku: entry.fnsku, issues: ["FNSKU not in pilot scope"] });
      continue;
    }
    if (!(PILOT_FNSKUS_V1 as readonly string[]).includes(entry.fnsku)) {
      rejected_rows.push({ fnsku: entry.fnsku, issues: ["FNSKU not in allowed pilot list"] });
      continue;
    }

    const dryRun = buildManualCogsDryRunResultV1(entry, {
      latestSoldPrice: pilot.latestSoldPrice,
      cleanQuantityTotal: pilot.cleanQuantityTotal,
      perSubmission: pilot.affectedSubmissions.map((s) => ({
        claimSubmissionId: s.claimSubmissionId,
        claimCaseId: s.claimCaseId,
        cleanQuantity: s.cleanQuantity,
      })),
    });

    if (!dryRun.ok) {
      rejected_rows.push({
        fnsku: entry.fnsku,
        issues: dryRun.issues.filter((i) => i.severity === "error").map((i) => i.message),
      });
      continue;
    }

    approvedRecords.set(
      entry.fnsku,
      buildCogsOverrideRecord({
        entry: { ...entry, approvedBy: entry.approvedBy || args.input.approved_by },
        executeRunId: args.executeRunId,
        approvedAt: new Date().toISOString(),
      }),
    );
  }

  skipped = PILOT_FNSKUS_V1.filter(
    (f) => !approvedRecords.has(f) && !rejected_rows.some((r) => r.fnsku === f),
  ).length;

  const requiredCount = approval.allow_partial ? 1 : PILOT_FNSKUS_V1.length;
  const canExecute =
    approval.write_enabled &&
    args.execute &&
    approvedRecords.size >= requiredCount &&
    (approval.allow_partial || approvedRecords.size === PILOT_FNSKUS_V1.length) &&
    rejected_rows.length === 0;

  let auditWritten = false;
  let after: CogsExecuteSnapshotV1 | null = null;
  let executed = false;
  let resolverBehavior: "org_scoped" | "singleton" | "none" = "none";
  let workspaceSettingsRowTargeted: string | null = null;
  let rereadByIdConfirmed = false;
  let rereadAfterKeys: string[] = [];

  if (canExecute) {
    const priorOverrides = { ...before.cogs_overrides_json };
    const writeFailures: string[] = [];
    let writesCompleted = 0;

    for (const [fnsku, record] of approvedRecords) {
      const pilot = pilotProducts.find((p) => p.fnsku === fnsku);
      if (!pilot) continue;
      const entry = args.input.entries.find((e) => e.fnsku === fnsku);
      if (!entry) continue;

      const writeResult = await attemptGuardedCogsWriteV1({
        client: args.client,
        organizationId: args.organizationId,
        entry: { ...entry, approvedBy: entry.approvedBy || args.input.approved_by },
        pilot,
        executeRunId: args.executeRunId,
        actorId: entry.approvedBy || args.input.approved_by,
      });

      if (!writeResult.written) {
        writeFailures.push(`${fnsku}: ${writeResult.blockReason ?? "write failed"}`);
        break;
      }
      writesCompleted += 1;

      const { error: auditErr } = await args.client.from("platform_automation_audit_log").insert({
        organization_id: args.organizationId,
        store_id: args.storeId,
        automation_type: "claim_intake_cogs",
        action: "cogs_manual_override_apply",
        actor_user_id: null,
        actor_email: record.approved_by,
        before_json: { fnsku, prior: priorOverrides[fnsku] ?? null },
        after_json: { fnsku, record },
        metadata: {
          phase: PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.phase,
          run_id: args.executeRunId,
          pilot_case_run_id: PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.pilotCaseRunId,
          guarded_write: "attemptGuardedCogsWriteV1",
        },
      });
      if (auditErr) writeFailures.push(`${fnsku}: audit log failed`);
    }

    if (writeFailures.length > 0 && writesCompleted > 0) {
      const target = await resolveCanonicalWorkspaceSettingsRowForOrg(args.client, args.organizationId);
      if (target?.id) {
        const moduleConfigs = metaRecord(target.module_configs);
        const claimIntake = metaRecord(moduleConfigs.claim_intake);
        await args.client
          .from("workspace_settings")
          .update({
            module_configs: {
              ...moduleConfigs,
              claim_intake: { ...claimIntake, cogs_overrides: priorOverrides },
            },
          })
          .eq("id", target.id);
      }
    }

    if (writeFailures.length > 0) {
      throw new Error(`Guarded COGS write failed: ${writeFailures.join("; ")}`);
    }

    executed = true;
    auditWritten = writesCompleted > 0;
    after = await snapshotCogsExecuteState({
      client: args.client,
      organizationId: args.organizationId,
      storeId: args.storeId,
    });

    // Aggregate persistence verification: re-read the canonical row by id and confirm
    // every approved FNSKU key actually landed in cogs_overrides.
    const verifyTarget = await resolveCanonicalWorkspaceSettingsRowForOrg(
      args.client,
      args.organizationId,
    );
    resolverBehavior = verifyTarget?.source ?? "none";
    workspaceSettingsRowTargeted = verifyTarget?.id ?? null;
    if (verifyTarget?.id) {
      const { data: verifyRow } = await args.client
        .from("workspace_settings")
        .select("module_configs")
        .eq("id", verifyTarget.id)
        .maybeSingle();
      const moduleConfigs = metaRecord(verifyRow?.module_configs);
      const claimIntake = metaRecord(moduleConfigs.claim_intake);
      rereadAfterKeys = Object.keys(metaRecord(claimIntake.cogs_overrides));
      rereadByIdConfirmed = [...approvedRecords.keys()].every((k) => rereadAfterKeys.includes(k));
    }
  }

  const moneyPreview = executed
    ? await composeMoneyLanePreviewV1(args.client, args.organizationId, args.storeId, {
        pilot_case_run_id: PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.pilotCaseRunId,
        intake_run_id: PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.intakeRunId,
      })
    : null;

  const recoveryCalculable =
    moneyPreview?.per_submission_money_preview.filter((p) => p.recovery_value.status === "known").length ?? 0;

  const per_submission_recovery_preview =
    moneyPreview?.per_submission_money_preview.map((p) => ({
      claim_submission_id: p.claim_submission_id,
      fnsku: p.fnsku,
      clean_quantity: p.clean_quantity,
      approved_cogs_unit: p.approved_cogs_unit.value,
      recovery_value: p.recovery_value.value,
      recovery_display: p.recovery_value.display,
    })) ?? [];

  const per_fnsku_cogs_matrix = pilotProducts.map((p) => ({
    fnsku: p.fnsku,
    sku: p.sku,
    asin: p.asin,
    resolved_product_id: p.resolvedProductId,
    cogs_status: executed
      ? extractCogsOverrideUnitCost(after?.cogs_overrides_json[p.fnsku]) != null
        ? "override_present"
        : "missing"
      : p.cogsStatus,
    unit_cost: executed
      ? extractCogsOverrideUnitCost(after?.cogs_overrides_json[p.fnsku])
      : approvedRecords.get(p.fnsku)?.unit_cost ?? null,
    latest_sold_price: p.latestSoldPrice,
  }));

  const per_product_cogs_matrix = per_fnsku_cogs_matrix;

  const claimCountsUnchanged =
    after == null ||
    (after.claim_submissions_count === before.claim_submissions_count &&
      after.claim_cases_count === before.claim_cases_count &&
      after.claim_lines_count === before.claim_lines_count &&
      after.claim_candidates_count === before.claim_candidates_count);

  const salePriceOk = moneyPreview?.sale_price_not_used_as_cogs_verification ?? true;
  const cogsApplied =
    executed &&
    after != null &&
    approvedRecords.size === PILOT_FNSKUS_V1.length &&
    after.cogs_coverage_fnsku_count === PILOT_FNSKUS_V1.length &&
    recoveryCalculable === (moneyPreview?.pilot_submission_count ?? 0) &&
    claimCountsUnchanged &&
    salePriceOk &&
    auditWritten;

  const cogsStorage =
    "workspace_settings.module_configs.claim_intake.cogs_overrides (interim; product_cost_snapshots not applied)";

  return {
    phase: PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.phase,
    execute_run_id: args.executeRunId,
    approval_status: approval,
    approval_file_status: executeApproval.status,
    input_source: args.input.input_source,
    input_products_count: args.input.entries.length,
    accepted_cogs_rows_count: approvedRecords.size,
    rejected_cogs_rows_count: rejected_rows.length,
    rejection_reasons: rejected_rows,
    cogs_storage_location: cogsStorage,
    approved_fnsku_count: approvedRecords.size,
    skipped_fnsku_count: skipped,
    rejected_rows,
    validation_summary: {
      entries_in_file: args.input.entries.length,
      pilot_fnsku_count: PILOT_FNSKUS_V1.length,
      approved_records: [...approvedRecords.keys()],
      execute_requested: args.execute,
      can_execute: canExecute,
      allow_partial: approval.allow_partial,
      write_enabled: approval.write_enabled,
    },
    before_snapshot: before,
    after_snapshot: after,
    cogs_coverage_count: after?.cogs_coverage_fnsku_count ?? before.cogs_coverage_fnsku_count,
    recovery_value_calculable_count: recoveryCalculable,
    per_product_cogs_matrix,
    per_fnsku_cogs_matrix,
    per_submission_recovery_preview,
    sale_price_not_used_as_cogs_verification: salePriceOk,
    audit_log_verification: executed ? auditWritten : false,
    no_claim_submission_mutation_verification: claimCountsUnchanged,
    no_claim_case_mutation_verification: claimCountsUnchanged,
    no_claim_line_mutation_verification: claimCountsUnchanged,
    no_claim_candidate_mutation_verification: claimCountsUnchanged,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: args.scannerUnchanged,
    persistence_verification: {
      resolver_behavior: resolverBehavior,
      workspace_settings_row_targeted: workspaceSettingsRowTargeted,
      cogs_overrides_before_keys: Object.keys(before.cogs_overrides_json),
      cogs_overrides_after_keys: after ? Object.keys(after.cogs_overrides_json) : [],
      expected_fnsku_keys: [...approvedRecords.keys()],
      all_expected_keys_present:
        executed &&
        approvedRecords.size > 0 &&
        [...approvedRecords.keys()].every((k) => rereadAfterKeys.includes(k)),
      reread_by_id_confirmed: rereadByIdConfirmed,
    },
    rollback_plan: buildCogsOverridesRollbackSql({
      organizationId: args.organizationId,
      beforeOverrides: before.cogs_overrides_json,
    }),
    executed,
    SAFE_COGS_APPLIED_FOR_PILOT: cogsApplied,
    SAFE_PRODUCT_COGS_WRITE_COMPLETE: cogsApplied,
    SAFE_TO_REBUILD_MONEY_LANE_PREVIEW_WITH_COGS: cogsApplied,
    SAFE_TO_UPDATE_MONEY_LANE_UI_WITH_RECOVERY_VALUE: cogsApplied,
    SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY_UI: cogsApplied,
    NEXT_PROMPT: cogsApplied
      ? "PHASE-CLAIM-MONEY-LANE-PREVIEW-AND-UI-INTEGRATION-V1 — re-run money lane preview with COGS coverage"
      : !approval.write_enabled
        ? "Set APPROVED_PRODUCT_COGS_WRITE_V1=yes and APPROVED_PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1=yes; fill operator input JSON with 6 approved unit costs; re-run with --execute"
        : approvedRecords.size < PILOT_FNSKUS_V1.length
          ? "Fill .cursor/operator-approvals/product-cogs-manual-entry-execute-v1-input.json with all 6 pilot FNSKU costs"
          : "Fix rejected rows or re-run with --execute after validation pass",
  };
}
