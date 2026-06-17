/**
 * PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-BUILD-V1 — guarded write path.
 * Default blocked unless APPROVED_PRODUCT_COGS_WRITE_V1=yes and execute approval.
 */
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildManualCogsDryRunResultV1,
  type ManualCogsEntryInputV1,
  type PilotProductCogsRowV1,
} from "@/lib/claims/submission/product-cogs-manual-entry-ui-v1";
import {
  buildCogsOverrideRecord,
  type CogsExecuteSnapshotV1,
} from "@/lib/claims/submission/product-cogs-manual-entry-execute-v1";
import {
  COGS_BUILD_APPROVAL_KEYS,
  readCogsBuildApprovalStatus,
} from "@/lib/products/contracts/product-cogs-source-build-v1";

export type CogsGuardedWriteResultV1 = {
  ok: boolean;
  blocked: boolean;
  blockReason: string | null;
  approvalKey: string;
  dryRun: boolean;
  written: boolean;
  fnsku: string;
  issues: Array<{ field: string; code: string; message: string }>;
  beforeSnapshot: CogsExecuteSnapshotV1 | null;
  afterSnapshot: CogsExecuteSnapshotV1 | null;
};

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readGuardedWriteApprovalStatus(): {
  write_enabled: boolean;
  block_reason: string | null;
} {
  const build = readCogsBuildApprovalStatus();
  const executePath = ".cursor/operator-approvals/product-cogs-manual-entry-execute-v1-approval.md";
  const executeKey = "APPROVED_PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1";
  const executeApproved = (() => {
    const p = path.join(process.cwd(), executePath);
    if (!fs.existsSync(p)) return false;
    return new RegExp(`^${executeKey}\\s*=\\s*yes\\s*$`, "im").test(fs.readFileSync(p, "utf8"));
  })();

  if (!build.write_enabled) {
    return {
      write_enabled: false,
      block_reason: `${COGS_BUILD_APPROVAL_KEYS.write}=yes required in product-cogs-source-build-v1-approval.md`,
    };
  }
  if (!executeApproved) {
    return {
      write_enabled: false,
      block_reason: `${executeKey}=yes required in product-cogs-manual-entry-execute-v1-approval.md`,
    };
  }
  return { write_enabled: true, block_reason: null };
}

async function snapshotCounts(
  client: SupabaseClient,
  organizationId: string,
): Promise<CogsExecuteSnapshotV1> {
  const [subs, cases, lines, cands, settings] = await Promise.all([
    client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client
      .from("workspace_settings")
      .select("module_configs")
      .eq("organization_id", organizationId)
      .maybeSingle(),
  ]);

  const moduleConfigs = metaRecord(settings.data?.module_configs);
  const claimIntake = metaRecord(moduleConfigs.claim_intake);
  const overrides = metaRecord(claimIntake.cogs_overrides);

  return {
    cogs_override_keys: Object.keys(overrides),
    cogs_coverage_fnsku_count: Object.keys(overrides).length,
    claim_submissions_count: subs.count ?? 0,
    claim_cases_count: cases.count ?? 0,
    claim_lines_count: lines.count ?? 0,
    claim_candidates_count: cands.count ?? 0,
    cogs_overrides_json: overrides,
  };
}

export async function attemptGuardedCogsWriteV1(args: {
  client: SupabaseClient;
  organizationId: string;
  entry: ManualCogsEntryInputV1;
  pilot: PilotProductCogsRowV1;
  executeRunId: string;
  actorId: string;
}): Promise<CogsGuardedWriteResultV1> {
  const approval = readGuardedWriteApprovalStatus();
  const dryRun = buildManualCogsDryRunResultV1(args.entry, {
    latestSoldPrice: args.pilot.latestSoldPrice,
    cleanQuantityTotal: args.pilot.cleanQuantityTotal,
    perSubmission: args.pilot.affectedSubmissions.map((s) => ({
      claimSubmissionId: s.claimSubmissionId,
      claimCaseId: s.claimCaseId,
      cleanQuantity: s.cleanQuantity,
    })),
  });

  if (!approval.write_enabled) {
    return {
      ok: false,
      blocked: true,
      blockReason: approval.block_reason ?? `${COGS_BUILD_APPROVAL_KEYS.write}=yes required`,
      approvalKey: COGS_BUILD_APPROVAL_KEYS.write,
      dryRun: true,
      written: false,
      fnsku: args.entry.fnsku,
      issues: dryRun.issues.map((i) => ({ field: i.field, code: i.code, message: i.message })),
      beforeSnapshot: null,
      afterSnapshot: null,
    };
  }

  if (!dryRun.ok) {
    return {
      ok: false,
      blocked: false,
      blockReason: "Validation failed",
      approvalKey: COGS_BUILD_APPROVAL_KEYS.write,
      dryRun: false,
      written: false,
      fnsku: args.entry.fnsku,
      issues: dryRun.issues.map((i) => ({ field: i.field, code: i.code, message: i.message })),
      beforeSnapshot: null,
      afterSnapshot: null,
    };
  }

  const beforeSnapshot = await snapshotCounts(args.client, args.organizationId);
  const approvedAt = new Date().toISOString();
  const record = buildCogsOverrideRecord({
    entry: args.entry,
    executeRunId: args.executeRunId,
    approvedAt,
  });

  const { data: settingsRow } = await args.client
    .from("workspace_settings")
    .select("module_configs")
    .eq("organization_id", args.organizationId)
    .maybeSingle();

  const moduleConfigs = metaRecord(settingsRow?.module_configs);
  const claimIntake = metaRecord(moduleConfigs.claim_intake);
  const priorOverrides = metaRecord(claimIntake.cogs_overrides);
  const nextOverrides = { ...priorOverrides, [args.entry.fnsku]: record };

  const { error } = await args.client
    .from("workspace_settings")
    .update({
      module_configs: {
        ...moduleConfigs,
        claim_intake: {
          ...claimIntake,
          cogs_overrides: nextOverrides,
        },
      },
    })
    .eq("organization_id", args.organizationId);

  if (error) {
    return {
      ok: false,
      blocked: false,
      blockReason: error.message,
      approvalKey: COGS_BUILD_APPROVAL_KEYS.write,
      dryRun: false,
      written: false,
      fnsku: args.entry.fnsku,
      issues: [{ field: "write", code: "db_error", message: error.message }],
      beforeSnapshot,
      afterSnapshot: null,
    };
  }

  const afterSnapshot = await snapshotCounts(args.client, args.organizationId);

  return {
    ok: true,
    blocked: false,
    blockReason: null,
    approvalKey: COGS_BUILD_APPROVAL_KEYS.write,
    dryRun: false,
    written: true,
    fnsku: args.entry.fnsku,
    issues: [],
    beforeSnapshot,
    afterSnapshot,
  };
}
