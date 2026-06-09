import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  RemovalApiSyncSchedule,
  StoreAutomationSettings,
} from "./platform-automation-settings-types";
import { getSessionUserIdFromCookies } from "./supabase-server-auth";

const SECRET_KEY_PATTERN = /(secret|password|token|api_key|credential|refresh_token|access_token)/i;

export type PlatformAutomationAuditActor = {
  actor_user_id: string | null;
  actor_email: string | null;
};

export type PlatformAutomationAuditEntry = {
  organization_id: string;
  store_id: string;
  automation_type: string;
  action: string;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
};

function stripSecrets(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripSecrets);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = stripSecrets(v);
  }
  return out;
}

export async function resolvePlatformAutomationAuditActor(
  client: SupabaseClient,
): Promise<PlatformAutomationAuditActor> {
  const actor_user_id = await getSessionUserIdFromCookies();
  if (!actor_user_id) return { actor_user_id: null, actor_email: null };
  const { data } = await client.from("profiles").select("email").eq("id", actor_user_id).maybeSingle();
  const email = typeof (data as { email?: string } | null)?.email === "string" ? data!.email! : null;
  return { actor_user_id, actor_email: email };
}

export async function writePlatformAutomationAuditLogs(
  client: SupabaseClient,
  actor: PlatformAutomationAuditActor,
  entries: PlatformAutomationAuditEntry[],
): Promise<void> {
  if (!entries.length) return;
  const rows = entries.map((e) => ({
    organization_id: e.organization_id,
    store_id: e.store_id,
    automation_type: e.automation_type,
    action: e.action,
    actor_user_id: actor.actor_user_id,
    actor_email: actor.actor_email,
    before_json: e.before_json ? stripSecrets(e.before_json) : null,
    after_json: e.after_json ? stripSecrets(e.after_json) : null,
    metadata: stripSecrets(e.metadata ?? {}) as Record<string, unknown>,
  }));
  const { error } = await client.from("platform_automation_audit_log").insert(rows);
  if (error) {
    console.error("[writePlatformAutomationAuditLogs]", error.message);
  }
}

function recentSnapshot(removal: RemovalApiSyncSchedule): Record<string, unknown> {
  const rs = removal.recent_sync;
  return {
    enabled: removal.enabled,
    runs_per_day: rs.runs_per_day,
    run_times_local: rs.run_times_local,
    timezone: rs.timezone,
    rolling_days: rs.rolling_days,
    max_runtime_seconds: rs.max_runtime_seconds,
    report_types: rs.report_types,
    rebuild_expected_packages: rs.rebuild_expected_packages,
    retry_on_failure: rs.retry_on_failure,
  };
}

/** Field-level audit entries for removal_api_sync save. */
export function diffRemovalAutomationAuditEntries(
  organizationId: string,
  storeId: string,
  before: StoreAutomationSettings,
  after: StoreAutomationSettings,
): PlatformAutomationAuditEntry[] {
  const b = recentSnapshot(before.removal_api_sync);
  const a = recentSnapshot(after.removal_api_sync);
  const base = { organization_id: organizationId, store_id: storeId, automation_type: "removal_api_sync" };
  const entries: PlatformAutomationAuditEntry[] = [];

  const push = (action: string, field: string, beforeVal: unknown, afterVal: unknown) => {
    if (JSON.stringify(beforeVal) === JSON.stringify(afterVal)) return;
    entries.push({
      ...base,
      action,
      before_json: { field, value: beforeVal },
      after_json: { field, value: afterVal },
      metadata: { source: "platform_automation_ui" },
    });
  };

  push("schedule_enabled_changed", "enabled", b.enabled, a.enabled);
  push("runs_per_day_changed", "runs_per_day", b.runs_per_day, a.runs_per_day);
  push("local_run_times_changed", "run_times_local", b.run_times_local, a.run_times_local);
  push("timezone_changed", "timezone", b.timezone, a.timezone);
  push("rolling_window_changed", "rolling_days", b.rolling_days, a.rolling_days);
  push("max_runtime_changed", "max_runtime_seconds", b.max_runtime_seconds, a.max_runtime_seconds);
  push("report_types_changed", "report_types", b.report_types, a.report_types);
  push(
    "rebuild_expected_packages_changed",
    "rebuild_expected_packages",
    b.rebuild_expected_packages,
    a.rebuild_expected_packages,
  );
  push("retry_on_failure_changed", "retry_on_failure", b.retry_on_failure, a.retry_on_failure);

  if (JSON.stringify(b) !== JSON.stringify(a)) {
    entries.unshift({
      ...base,
      action: "save",
      before_json: b,
      after_json: a,
      metadata: {
        source: "platform_automation_ui",
        field_change_count: entries.length,
      },
    });
  }

  return entries;
}

export function cronAuditEntry(args: {
  organizationId: string;
  storeId: string;
  action: "cron_tick" | "cron_run";
  gate?: Record<string, unknown>;
  result?: Record<string, unknown>;
}): PlatformAutomationAuditEntry {
  return {
    organization_id: args.organizationId,
    store_id: args.storeId,
    automation_type: "removal_api_sync",
    action: args.action,
    before_json: args.gate ? (stripSecrets(args.gate) as Record<string, unknown>) : null,
    after_json: args.result ? (stripSecrets(args.result) as Record<string, unknown>) : null,
    metadata: { source: "vercel_cron", route: "/api/cron/removal-nightly-sync" },
  };
}
export function manualRunAuditEntry(args: {
  organizationId: string;
  storeId: string;
  automationType: string;
  action: "run_now" | "resume";
  body?: Record<string, unknown>;
  result?: Record<string, unknown>;
  source?: string;
}): PlatformAutomationAuditEntry {
  return {
    organization_id: args.organizationId,
    store_id: args.storeId,
    automation_type: args.automationType,
    action: args.action,
    before_json: null,
    after_json: args.result ? (stripSecrets(args.result) as Record<string, unknown>) : null,
    metadata: {
      source: args.source ?? "platform_automation_ui",
      request: args.body ? stripSecrets(args.body) : {},
    },
  };
}
