"use server";

/**
 * Phase 7D — Claim Pool Generation automation card actions.
 * Manual run (dry-run / apply), schedule save, and status for the platform
 * Automation API center. Writes claim_candidates only in apply mode;
 * never promotes to claim_cases / claim_lines.
 */
import { canEditPlatformProductSettings } from "../../../../lib/platform-product-settings-access";
import {
  manualRunAuditEntry,
  resolvePlatformAutomationAuditActor,
  writePlatformAutomationAuditLogs,
} from "../../../../lib/platform-automation-audit-log";
import {
  computeClaimPoolGenerationNextRun,
  normalizeStoreAutomationSettings,
} from "../../../../lib/platform-automation-schedule";
import {
  automationScopeKey,
  parseAutomationPersisted,
  writeStoreAutomationSettings,
} from "../../../../lib/platform-automation-scope-storage";
import type {
  ClaimPoolGenerationSchedule,
  RemovalCronRuntimeState,
} from "../../../../lib/platform-automation-settings-types";
import {
  loadClaimPoolGenerationSchedule,
  persistClaimPoolCronRuntime,
  runClaimPoolGeneration,
  runStatusFromOutcome,
  type ClaimPoolRunOutcome,
} from "../../../../lib/claims/intake/claim-pool-automation-run";
import { listRegisteredClaimGenerators } from "../../../../lib/claims/intake/claim-generator-registry";
import { supabaseServer } from "../../../../lib/supabase-server";
import { isUuidString } from "../../../../lib/uuid";
import { getAuthenticatedPlatformRoleKey } from "../platform-settings-actions";

type AccessDenied = "not_authenticated" | "forbidden";

async function assertSuperadmin(): Promise<
  { ok: true } | { ok: false; accessDenied: AccessDenied }
> {
  const roleKey = await getAuthenticatedPlatformRoleKey();
  if (!roleKey) return { ok: false, accessDenied: "not_authenticated" };
  if (!canEditPlatformProductSettings(roleKey)) return { ok: false, accessDenied: "forbidden" };
  return { ok: true };
}

export type ClaimPoolGenerationStatus = {
  schedule: ClaimPoolGenerationSchedule;
  next_run_at: string | null;
  cron_runtime: RemovalCronRuntimeState | null;
  registered_generators: Array<{ source_kind: string; title: string }>;
  recent_runs: Array<{
    created_at: string | null;
    action: string;
    actor_email: string | null;
    result: Record<string, unknown> | null;
  }>;
};

export async function getClaimPoolGenerationStatusAction(args: {
  organizationId: string;
  storeId: string;
}): Promise<{ ok: true; status: ClaimPoolGenerationStatus } | { ok: false; error: string }> {
  const gate = await assertSuperadmin();
  if (!gate.ok) return { ok: false, error: "Not authorized." };
  const organizationId = args.organizationId.trim();
  const storeId = args.storeId.trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return { ok: false, error: "organization_id and store_id must be UUIDs." };
  }

  const { schedule } = await loadClaimPoolGenerationSchedule(supabaseServer, organizationId, storeId);

  const { data: auditRows } = await supabaseServer
    .from("platform_automation_audit_log")
    .select("created_at, action, actor_email, after_json")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("automation_type", "claim_pool_generation")
    .in("action", ["run_now", "cron_run"])
    .order("created_at", { ascending: false })
    .limit(5);

  return {
    ok: true,
    status: {
      schedule,
      next_run_at: computeClaimPoolGenerationNextRun(schedule)?.toISOString() ?? null,
      cron_runtime: schedule.cron_runtime ?? null,
      registered_generators: listRegisteredClaimGenerators().map((g) => ({
        source_kind: g.source_kind,
        title: g.title,
      })),
      recent_runs: ((auditRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
        created_at: typeof r.created_at === "string" ? r.created_at : null,
        action: String(r.action ?? ""),
        actor_email: typeof r.actor_email === "string" ? r.actor_email : null,
        result:
          r.after_json && typeof r.after_json === "object" && !Array.isArray(r.after_json)
            ? (r.after_json as Record<string, unknown>)
            : null,
      })),
    },
  };
}

export async function saveClaimPoolGenerationScheduleAction(args: {
  organizationId: string;
  storeId: string;
  schedule: ClaimPoolGenerationSchedule;
}): Promise<{ ok: true; schedule: ClaimPoolGenerationSchedule } | { ok: false; error: string }> {
  const gate = await assertSuperadmin();
  if (!gate.ok) return { ok: false, error: "Only super_admin can edit automation settings." };
  const organizationId = args.organizationId.trim();
  const storeId = args.storeId.trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return { ok: false, error: "organization_id and store_id must be UUIDs." };
  }

  const { data: existing, error: readErr } = await supabaseServer
    .from("platform_settings")
    .select("automation_settings")
    .eq("id", true)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };

  const raw = (existing as { automation_settings?: unknown } | null)?.automation_settings ?? null;
  const doc = parseAutomationPersisted(raw);
  const key = automationScopeKey(organizationId, storeId);
  const beforeScope = normalizeStoreAutomationSettings(doc.scopes[key] ?? {});
  const before = beforeScope.claim_pool_generation;

  // Normalize via the shared scope normalizer; preserve existing cron_runtime.
  const afterScope = normalizeStoreAutomationSettings({
    ...beforeScope,
    claim_pool_generation: {
      ...args.schedule,
      cron_runtime: before.cron_runtime,
    },
  });
  const persisted = writeStoreAutomationSettings(raw, organizationId, storeId, afterScope);

  const { error: writeErr } = await supabaseServer
    .from("platform_settings")
    .update({ automation_settings: persisted, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (writeErr) return { ok: false, error: writeErr.message };

  const actor = await resolvePlatformAutomationAuditActor(supabaseServer);
  const after = afterScope.claim_pool_generation;
  const snapshot = (s: ClaimPoolGenerationSchedule) => ({
    enabled: s.enabled,
    runs_per_day: s.runs_per_day,
    run_times_local: s.run_times_local,
    timezone: s.timezone,
    rolling_days: s.rolling_days,
    enabled_source_kinds: s.enabled_source_kinds,
    purchased_source_kinds: s.purchased_source_kinds,
    max_runtime_seconds: s.max_runtime_seconds,
    scheduled_mode: s.scheduled_mode,
    manual_window_start: s.manual_window_start,
    manual_window_end: s.manual_window_end,
  });
  if (JSON.stringify(snapshot(before)) !== JSON.stringify(snapshot(after))) {
    await writePlatformAutomationAuditLogs(supabaseServer, actor, [
      {
        organization_id: organizationId,
        store_id: storeId,
        automation_type: "claim_pool_generation",
        action: "save",
        before_json: snapshot(before),
        after_json: snapshot(after),
        metadata: { source: "platform_automation_ui" },
      },
    ]);
  }

  return { ok: true, schedule: after };
}

export type ClaimPoolManualRunResult =
  | { ok: true; outcome: ClaimPoolRunOutcome }
  | { ok: false; error: string };

export async function runClaimPoolGenerationNowAction(args: {
  organizationId: string;
  storeId: string;
  /** Subset of source kinds; omit/empty = all enabled on the card. */
  sources?: string[] | null;
  windowFrom?: string | null;
  windowTo?: string | null;
  /** Default false — dry-run. */
  apply?: boolean;
}): Promise<ClaimPoolManualRunResult> {
  const gate = await assertSuperadmin();
  if (!gate.ok) return { ok: false, error: "Only super_admin can run claim pool generation." };
  const organizationId = args.organizationId.trim();
  const storeId = args.storeId.trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return { ok: false, error: "organization_id and store_id must be UUIDs." };
  }

  const apply = args.apply === true;
  const { schedule } = await loadClaimPoolGenerationSchedule(supabaseServer, organizationId, storeId);

  const startedAt = new Date().toISOString();
  await persistClaimPoolCronRuntime(supabaseServer, organizationId, storeId, {
    last_run_at: startedAt,
    last_run_status: "running",
    last_error: null,
  });

  const outcome = await runClaimPoolGeneration({
    client: supabaseServer,
    organizationId,
    storeId,
    schedule,
    requestedSources: args.sources?.length ? args.sources : null,
    windowFrom: args.windowFrom?.trim() || null,
    windowTo: args.windowTo?.trim() || null,
    apply,
  });

  const finishedAt = new Date().toISOString();
  const status = runStatusFromOutcome(outcome);
  await persistClaimPoolCronRuntime(supabaseServer, organizationId, storeId, {
    last_run_at: finishedAt,
    last_run_status: status,
    last_error: outcome.error,
    last_success_at: status === "success" ? finishedAt : undefined,
    last_failed_at: status === "failed" ? finishedAt : undefined,
  });

  const actor = await resolvePlatformAutomationAuditActor(supabaseServer);
  await writePlatformAutomationAuditLogs(supabaseServer, actor, [
    manualRunAuditEntry({
      organizationId,
      storeId,
      automationType: "claim_pool_generation",
      action: "run_now",
      body: {
        sources: outcome.effective_sources,
        blocked_sources: outcome.blocked_sources,
        window: outcome.window,
        mode: outcome.mode,
      },
      result: {
        run_id: outcome.run_id,
        ok: outcome.ok,
        mode: outcome.mode,
        window: outcome.window,
        source_kinds: outcome.effective_sources,
        counts: outcome.counts,
        error: outcome.error,
      },
    }),
  ]);

  if (outcome.error && !outcome.per_source.length) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true, outcome };
}
