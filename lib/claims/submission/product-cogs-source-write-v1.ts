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

export type CanonicalWorkspaceSettingsRow = {
  id: string;
  module_configs: Record<string, unknown>;
  /** How the row was resolved: matched the org directly, or fell back to the app singleton. */
  source: "org_scoped" | "singleton";
};

/**
 * Resolves the canonical workspace_settings row for an org.
 *
 * The rest of the app (module gate, intake policy, white-label, settings actions)
 * treats workspace_settings as a singleton resolved via `.order("id").limit(1)`.
 * Historically the COGS path filtered by `.eq("organization_id", org)`, which never
 * matched the singleton (organization_id is NULL on it) — so reads returned empty
 * and updates silently affected 0 rows. We prefer an org-scoped row when present
 * and fall back to the singleton, matching the canonical convention. Callers must
 * target writes by `id` (never by organization_id only).
 */
export async function resolveCanonicalWorkspaceSettingsRowForOrg(
  client: SupabaseClient,
  organizationId: string,
): Promise<CanonicalWorkspaceSettingsRow | null> {
  const byOrg = await client
    .from("workspace_settings")
    .select("id, module_configs")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!byOrg.error && byOrg.data) {
    return {
      id: String((byOrg.data as { id: unknown }).id),
      module_configs: metaRecord((byOrg.data as { module_configs?: unknown }).module_configs),
      source: "org_scoped",
    };
  }

  const singleton = await client
    .from("workspace_settings")
    .select("id, module_configs")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!singleton.error && singleton.data) {
    return {
      id: String((singleton.data as { id: unknown }).id),
      module_configs: metaRecord((singleton.data as { module_configs?: unknown }).module_configs),
      source: "singleton",
    };
  }

  return null;
}

/** Reads cogs_overrides from the canonical workspace_settings row (org-scoped or singleton). */
export async function loadCogsOverridesCanonicalV1(
  client: SupabaseClient,
  organizationId: string,
): Promise<Record<string, unknown>> {
  const target = await resolveCanonicalWorkspaceSettingsRowForOrg(client, organizationId);
  const claimIntake = metaRecord(target?.module_configs.claim_intake);
  return metaRecord(claimIntake.cogs_overrides);
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
  const [subs, cases, lines, cands, overrides] = await Promise.all([
    client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    loadCogsOverridesCanonicalV1(client, organizationId),
  ]);

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

  const target = await resolveCanonicalWorkspaceSettingsRowForOrg(args.client, args.organizationId);
  const moduleConfigs = metaRecord(target?.module_configs);
  const claimIntake = metaRecord(moduleConfigs.claim_intake);
  const priorOverrides = metaRecord(claimIntake.cogs_overrides);
  const nextOverrides = { ...priorOverrides, [args.entry.fnsku]: record };
  const nextModuleConfigs = {
    ...moduleConfigs,
    claim_intake: {
      ...claimIntake,
      cogs_overrides: nextOverrides,
    },
  };

  // Persist + verify rows affected. A bare `.update().eq()` returns no error when 0
  // rows match, so we must confirm via `.select()` and create the row if none exists.
  let writeError: string | null = null;
  let rowsAffected = 0;
  let targetRowId = target?.id ?? null;
  if (target?.id) {
    const { data, error } = await args.client
      .from("workspace_settings")
      .update({ module_configs: nextModuleConfigs })
      .eq("id", target.id)
      .select("id");
    writeError = error?.message ?? null;
    rowsAffected = data?.length ?? 0;
  } else {
    const { data, error } = await args.client
      .from("workspace_settings")
      .insert({
        organization_id: args.organizationId,
        core_settings: {},
        module_configs: nextModuleConfigs,
      })
      .select("id");
    writeError = error?.message ?? null;
    rowsAffected = data?.length ?? 0;
    targetRowId = data && data.length > 0 ? String((data[0] as { id: unknown }).id) : null;
  }

  // Re-read the same row by id and confirm this FNSKU key actually landed.
  if (!writeError && rowsAffected > 0 && targetRowId) {
    const { data: verifyRow } = await args.client
      .from("workspace_settings")
      .select("module_configs")
      .eq("id", targetRowId)
      .maybeSingle();
    const verifyOverrides = metaRecord(
      metaRecord(metaRecord(verifyRow?.module_configs).claim_intake).cogs_overrides,
    );
    if (!(args.entry.fnsku in verifyOverrides)) {
      return {
        ok: false,
        blocked: false,
        blockReason: `Persistence verification failed: ${args.entry.fnsku} not found in workspace_settings(id=${targetRowId}) after write.`,
        approvalKey: COGS_BUILD_APPROVAL_KEYS.write,
        dryRun: false,
        written: false,
        fnsku: args.entry.fnsku,
        issues: [{ field: "write", code: "persistence_unverified", message: "cogs_override key missing on re-read." }],
        beforeSnapshot,
        afterSnapshot: null,
      };
    }
  }

  if (writeError) {
    return {
      ok: false,
      blocked: false,
      blockReason: writeError,
      approvalKey: COGS_BUILD_APPROVAL_KEYS.write,
      dryRun: false,
      written: false,
      fnsku: args.entry.fnsku,
      issues: [{ field: "write", code: "db_error", message: writeError }],
      beforeSnapshot,
      afterSnapshot: null,
    };
  }

  if (rowsAffected === 0) {
    return {
      ok: false,
      blocked: false,
      blockReason: "workspace_settings write affected 0 rows (no canonical settings row resolved).",
      approvalKey: COGS_BUILD_APPROVAL_KEYS.write,
      dryRun: false,
      written: false,
      fnsku: args.entry.fnsku,
      issues: [{ field: "write", code: "no_rows_affected", message: "cogs_overrides did not persist." }],
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
