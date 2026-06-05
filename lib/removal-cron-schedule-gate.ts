import pg from "pg";

import {
  evaluateLocalDailyScheduleDue,
  REMOVAL_CRON_WAKE_GRACE_MS,
} from "./automation-timezone-schedule";
import { readStoreAutomationSettings } from "./platform-automation-scope-storage";
import { computeRemovalRecentNextRun } from "./platform-automation-schedule";
import {
  EMPTY_REMOVAL_CRON_RUNTIME,
  type RemovalCronRuntimeState,
  type RemovalRecentSyncSchedule,
  type StoreAutomationSettings,
} from "./platform-automation-settings-types";
import { PRODUCTION_ORG_ID, PRODUCTION_STORE_ID } from "./production-removal-sync-run";
import { productionPostgresUrl } from "./production-db-bind";
import { readRemovalCronRuntimeFromPg } from "./removal-cron-runtime-storage";
import { supabaseServer } from "./supabase-server";

/** Vercel Hobby: daily cron only. Business slots still from platform_settings. */
export const VERCEL_REMOVAL_CRON_WAKE_SCHEDULE = "0 8 * * *";

export type RemovalCronGateEvaluation = {
  settings_source: "platform_settings.automation_settings.scopes[org:store].removal_api_sync";
  organization_id: string;
  store_id: string;
  enabled: boolean;
  due: boolean;
  reason: string;
  next_run_at: string | null;
  schedule: {
    timezone: string;
    run_times_local: string[];
    run_hours_utc: number[];
    rolling_days: number;
    report_types: string[];
    rebuild_expected_packages: boolean;
    max_runtime_seconds: number;
  };
  cron_runtime: RemovalCronRuntimeState;
  matched_slot_key: string | null;
  vercel_wake_schedule: string;
};

export async function loadProductionRemovalAutomationSettings(): Promise<{
  settings: StoreAutomationSettings;
  scope: StoreAutomationSettings["removal_api_sync"];
  cron_runtime: RemovalCronRuntimeState;
}> {
  const { data, error } = await supabaseServer
    .from("platform_settings")
    .select("automation_settings")
    .eq("id", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const settings = readStoreAutomationSettings(
    (data as { automation_settings?: unknown } | null)?.automation_settings,
    PRODUCTION_ORG_ID,
    PRODUCTION_STORE_ID,
  );
  return {
    settings,
    scope: settings.removal_api_sync,
    cron_runtime: settings.removal_api_sync.cron_runtime ?? { ...EMPTY_REMOVAL_CRON_RUNTIME },
  };
}

function effectiveRunTimes(recent: RemovalRecentSyncSchedule): string[] {
  if (recent.run_times_local.length) return recent.run_times_local;
  return recent.run_hours_utc.map((h) => `${String(h).padStart(2, "0")}:00`);
}

export function evaluateRemovalCronGate(input: {
  scope: StoreAutomationSettings["removal_api_sync"];
  cron_runtime: RemovalCronRuntimeState;
  now?: Date;
}): RemovalCronGateEvaluation {
  const now = input.now ?? new Date();
  const recent = input.scope.recent_sync;
  const enabled = input.scope.enabled;
  const runTimes = effectiveRunTimes(recent);
  const useLocal = recent.run_times_local.length > 0;

  let due = false;
  let reason = "not_scheduled";
  let next_run_at = computeRemovalRecentNextRun(input.scope, now)?.toISOString() ?? null;
  let matched_slot_key: string | null = null;

  if (!enabled) {
    reason = "schedule_disabled";
  } else if (input.cron_runtime.last_run_status === "running" && input.cron_runtime.last_run_at) {
    const started = Date.parse(input.cron_runtime.last_run_at);
    const maxMs = recent.max_runtime_seconds * 1000;
    if (Number.isFinite(started) && now.getTime() - started < maxMs) {
      due = false;
      reason = "overlap_running";
    }
  }

  if (enabled && reason !== "overlap_running") {
    if (useLocal) {
      const evalLocal = evaluateLocalDailyScheduleDue({
        enabled: true,
        timeZone: recent.timezone,
        runTimesLocal: runTimes,
        lastRunAt: input.cron_runtime.last_run_at,
        lastSlotKey: input.cron_runtime.last_slot_key,
        now,
        graceMs: REMOVAL_CRON_WAKE_GRACE_MS,
      });
      due = evalLocal.due;
      reason = evalLocal.reason;
      next_run_at = evalLocal.next_run_at;
      matched_slot_key = evalLocal.matched_slot_key;
    } else {
      const hour = now.getUTCHours();
      const hours = [...new Set(recent.run_hours_utc)].sort((a, b) => a - b);
      const hourMatch = hours.includes(hour);
      const lastRunMs = input.cron_runtime.last_run_at ? Date.parse(input.cron_runtime.last_run_at) : NaN;
      const slotStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0);
      const alreadyRan = Number.isFinite(lastRunMs) && lastRunMs >= slotStart;
      due = hourMatch && !alreadyRan;
      reason = !hourMatch ? "not_scheduled" : alreadyRan ? "already_ran_this_slot" : "utc_hour_match";
      next_run_at = computeRemovalRecentNextRun(input.scope, now)?.toISOString() ?? null;
    }
  }

  return {
    settings_source: "platform_settings.automation_settings.scopes[org:store].removal_api_sync",
    organization_id: PRODUCTION_ORG_ID,
    store_id: PRODUCTION_STORE_ID,
    enabled,
    due,
    reason,
    next_run_at,
    matched_slot_key,
    schedule: {
      timezone: recent.timezone,
      run_times_local: recent.run_times_local,
      run_hours_utc: recent.run_hours_utc,
      rolling_days: recent.rolling_days,
      report_types: recent.report_types,
      rebuild_expected_packages: recent.rebuild_expected_packages,
      max_runtime_seconds: recent.max_runtime_seconds,
    },
    cron_runtime: input.cron_runtime,
    vercel_wake_schedule: VERCEL_REMOVAL_CRON_WAKE_SCHEDULE,
  };
}

export async function tryAcquireRemovalCronAdvisoryLock(
  organizationId: string,
  storeId: string,
): Promise<{ acquired: boolean; reason: string; release: () => Promise<void> }> {
  const key = `removal_cron:${organizationId}:${storeId}`;
  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const r = await client.query(`SELECT pg_try_advisory_lock(hashtext($1::text)) AS ok`, [key]);
  const acquired = Boolean(r.rows[0]?.ok);
  return {
    acquired,
    reason: acquired ? "advisory_lock_acquired" : "advisory_lock_held",
    release: async () => {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1::text))`, [key]);
      } finally {
        await client.end();
      }
    },
  };
}

export async function evaluateProductionRemovalCronGate(now?: Date): Promise<RemovalCronGateEvaluation> {
  const loaded = await loadProductionRemovalAutomationSettings();
  let cron_runtime = loaded.cron_runtime;
  try {
    const client = new pg.Client({
      connectionString: productionPostgresUrl(),
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      cron_runtime = await readRemovalCronRuntimeFromPg(client, PRODUCTION_ORG_ID, PRODUCTION_STORE_ID);
    } finally {
      await client.end();
    }
  } catch {
    /* use settings embedded runtime */
  }
  return evaluateRemovalCronGate({ scope: loaded.scope, cron_runtime, now });
}
