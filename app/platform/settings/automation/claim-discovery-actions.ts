"use server";

import { canEditPlatformProductSettings } from "../../../../lib/platform-product-settings-access";
import {
  manualRunAuditEntry,
  resolvePlatformAutomationAuditActor,
  writePlatformAutomationAuditLogs,
} from "../../../../lib/platform-automation-audit-log";
import {
  computeClaimDiscoveryNextRun,
  normalizeStoreAutomationSettings,
} from "../../../../lib/platform-automation-schedule";
import {
  automationScopeKey,
  parseAutomationPersisted,
  writeStoreAutomationSettings,
} from "../../../../lib/platform-automation-scope-storage";
import type { ClaimDiscoverySchedule } from "../../../../lib/platform-automation-settings-types";
import {
  discoveryRunStatusFromOutcome,
  loadClaimDiscoverySchedule,
  persistClaimDiscoveryCronRuntime,
  runClaimDiscoveryAutomation,
} from "../../../../lib/claims/discovery/claim-discovery-automation-run";
import { loadDiscoveryIndexState } from "../../../../lib/claims/discovery/claim-discovery-index";
import { CLAIM_DISCOVERY_SOURCE_KINDS } from "../../../../lib/platform-automation-settings-types";
import type { ClaimDiscoveryRunOutcome } from "../../../../lib/claims/discovery/claim-discovery-types";
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

export type ClaimDiscoveryStatus = {
  schedule: ClaimDiscoverySchedule;
  next_run_at: string | null;
  cron_runtime: ClaimDiscoverySchedule["cron_runtime"] | null;
  discovery_index: Awaited<ReturnType<typeof loadDiscoveryIndexState>>;
  registered_generators: Array<{ source_kind: string; title: string }>;
  recent_runs: Array<{
    created_at: string | null;
    action: string;
    actor_email: string | null;
    result: Record<string, unknown> | null;
  }>;
};

export async function getClaimDiscoveryStatusAction(args: {
  organizationId: string;
  storeId: string;
}): Promise<{ ok: true; status: ClaimDiscoveryStatus } | { ok: false; error: string }> {
  const gate = await assertSuperadmin();
  if (!gate.ok) return { ok: false, error: "Not authorized." };
  const organizationId = args.organizationId.trim();
  const storeId = args.storeId.trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return { ok: false, error: "organization_id and store_id must be UUIDs." };
  }

  const [{ schedule }, discovery_index] = await Promise.all([
    loadClaimDiscoverySchedule(supabaseServer, organizationId, storeId),
    loadDiscoveryIndexState(supabaseServer, organizationId),
  ]);

  const { data: auditRows } = await supabaseServer
    .from("platform_automation_audit_log")
    .select("created_at, action, actor_email, after_json")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("automation_type", "claim_discovery")
    .in("action", ["run_now", "cron_run"])
    .order("created_at", { ascending: false })
    .limit(5);

  const discoveryKinds = new Set<string>(CLAIM_DISCOVERY_SOURCE_KINDS);
  return {
    ok: true,
    status: {
      schedule,
      next_run_at: computeClaimDiscoveryNextRun(schedule)?.toISOString() ?? null,
      cron_runtime: schedule.cron_runtime ?? null,
      discovery_index,
      registered_generators: listRegisteredClaimGenerators().filter((g) =>
        discoveryKinds.has(g.source_kind),
      ),
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

export async function saveClaimDiscoveryScheduleAction(args: {
  organizationId: string;
  storeId: string;
  schedule: ClaimDiscoverySchedule;
}): Promise<{ ok: true; schedule: ClaimDiscoverySchedule } | { ok: false; error: string }> {
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
  const before = beforeScope.claim_discovery;

  const afterScope = normalizeStoreAutomationSettings({
    ...beforeScope,
    claim_discovery: {
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
  const after = afterScope.claim_discovery;
  const snapshot = (s: ClaimDiscoverySchedule) => ({
    enabled: s.enabled,
    runs_per_day: s.runs_per_day,
    run_times_local: s.run_times_local,
    timezone: s.timezone,
    initial_lookback_days: s.initial_lookback_days,
    incremental_overlap_days: s.incremental_overlap_days,
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
        automation_type: "claim_discovery",
        action: "save",
        before_json: snapshot(before),
        after_json: snapshot(after),
        metadata: { source: "platform_automation_ui" },
      },
    ]);
  }

  return { ok: true, schedule: after };
}

export type ClaimDiscoveryManualRunResult =
  | { ok: true; outcome: ClaimDiscoveryRunOutcome }
  | { ok: false; error: string };

export async function runClaimDiscoveryNowAction(args: {
  organizationId: string;
  storeId: string;
  sources?: string[] | null;
  windowFrom?: string | null;
  windowTo?: string | null;
  apply?: boolean;
}): Promise<ClaimDiscoveryManualRunResult> {
  const gate = await assertSuperadmin();
  if (!gate.ok) return { ok: false, error: "Only super_admin can run claim discovery." };
  const organizationId = args.organizationId.trim();
  const storeId = args.storeId.trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return { ok: false, error: "organization_id and store_id must be UUIDs." };
  }

  const apply = args.apply === true;
  const { schedule } = await loadClaimDiscoverySchedule(supabaseServer, organizationId, storeId);

  const startedAt = new Date().toISOString();
  await persistClaimDiscoveryCronRuntime(supabaseServer, organizationId, storeId, {
    last_run_at: startedAt,
    last_run_status: "running",
    last_error: null,
  });

  const outcome = await runClaimDiscoveryAutomation({
    client: supabaseServer,
    organizationId,
    storeId,
    schedule,
    requestedSources: args.sources?.length ? args.sources : null,
    windowFrom: args.windowFrom?.trim() || null,
    windowTo: args.windowTo?.trim() || null,
    apply,
    runKind: "manual",
  });

  const finishedAt = new Date().toISOString();
  const status = discoveryRunStatusFromOutcome(outcome);
  await persistClaimDiscoveryCronRuntime(supabaseServer, organizationId, storeId, {
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
      automationType: "claim_discovery",
      action: "run_now",
      body: {
        sources: args.sources ?? schedule.enabled_source_kinds,
        window_from: args.windowFrom ?? null,
        window_to: args.windowTo ?? null,
        mode: outcome.mode,
      },
      result: {
        run_id: outcome.run_id,
        ok: outcome.ok,
        mode: outcome.mode,
        indexed_sources: outcome.indexed_sources,
        counts: outcome.counts,
        queue_eligible: outcome.counts.queue_eligible,
        error: outcome.error,
      },
    }),
  ]);

  if (outcome.error && outcome.counts.sources_ran === 0) {
    return { ok: false, error: outcome.error };
  }
  return { ok: true, outcome };
}
