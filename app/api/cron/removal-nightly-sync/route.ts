import { NextResponse } from "next/server";

import {
  evaluateProductionRemovalCronGate,
  loadProductionRemovalAutomationSettings,
  tryAcquireRemovalCronAdvisoryLock,
  VERCEL_REMOVAL_CRON_WAKE_SCHEDULE,
} from "@/lib/removal-cron-schedule-gate";
import { persistRemovalCronRuntime } from "@/lib/removal-cron-runtime-storage";
import {
  PRODUCTION_ORG_ID,
  PRODUCTION_STORE_ID,
  runProductionRemovalSync,
  syncWindowThroughToday,
} from "@/lib/production-removal-sync-run";
import { PRODUCTION_REF } from "@/lib/production-db-bind";
import { computeRemovalRecentNextRun } from "@/lib/platform-automation-schedule";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

/**
 * Vercel wake-up route — execution gated by platform_settings automation schedule.
 * Vercel cron: daily wake (see vercel.json); business schedule from DB only.
 */
export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const urlRef = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!urlRef.includes(PRODUCTION_REF)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Cron refused: NEXT_PUBLIC_SUPABASE_URL must target production ${PRODUCTION_REF}`,
        code: "wrong_db_ref",
      },
      { status: 503 },
    );
  }

  if (process.env.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON !== "true") {
    return NextResponse.json(
      {
        ok: false,
        error: "ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON is not true",
        code: "cron_disabled",
      },
      { status: 503 },
    );
  }

  const gate = await evaluateProductionRemovalCronGate();

  if (!gate.enabled) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "schedule_disabled",
      settings_source: gate.settings_source,
      next_run_at: gate.next_run_at,
      vercel_wake_schedule: VERCEL_REMOVAL_CRON_WAKE_SCHEDULE,
    });
  }

  if (!gate.due) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: gate.reason,
      settings_source: gate.settings_source,
      next_run_at: gate.next_run_at,
      schedule: gate.schedule,
      vercel_wake_schedule: VERCEL_REMOVAL_CRON_WAKE_SCHEDULE,
    });
  }

  const lock = await tryAcquireRemovalCronAdvisoryLock(PRODUCTION_ORG_ID, PRODUCTION_STORE_ID);
  if (!lock.acquired) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "overlap_lock",
      overlap: lock.reason,
      settings_source: gate.settings_source,
      next_run_at: gate.next_run_at,
    });
  }

  const startedAt = new Date().toISOString();
  let loadedScope = gate.schedule;
  try {
    const loaded = await loadProductionRemovalAutomationSettings();
    loadedScope = {
      timezone: loaded.scope.recent_sync.timezone,
      run_times_local: loaded.scope.recent_sync.run_times_local,
      run_hours_utc: loaded.scope.recent_sync.run_hours_utc,
      rolling_days: loaded.scope.recent_sync.rolling_days,
      report_types: loaded.scope.recent_sync.report_types,
      rebuild_expected_packages: loaded.scope.recent_sync.rebuild_expected_packages,
      max_runtime_seconds: loaded.scope.recent_sync.max_runtime_seconds,
    };

    await persistRemovalCronRuntime(
      PRODUCTION_ORG_ID,
      PRODUCTION_STORE_ID,
      {
        last_run_at: startedAt,
        last_run_status: "running",
        last_error: null,
        last_slot_key: gate.matched_slot_key,
      },
      loaded.scope,
    );

    const reportTypes = new Set(loaded.scope.recent_sync.report_types);
    const result = await runProductionRemovalSync({
      window: syncWindowThroughToday(loaded.scope.recent_sync.rolling_days),
      fetchRemovalOrder: reportTypes.has("removal_order"),
      fetchRemovalShipment: reportTypes.has("removal_shipment"),
      rebuildExpectedPackages: loaded.scope.recent_sync.rebuild_expected_packages,
    });

    const finishedAt = new Date().toISOString();
    const success = result.errors.length === 0;
    const nextRun = computeRemovalRecentNextRun(loaded.scope, new Date())?.toISOString() ?? null;

    await persistRemovalCronRuntime(
      PRODUCTION_ORG_ID,
      PRODUCTION_STORE_ID,
      {
        last_run_at: finishedAt,
        last_run_status: success ? "success" : "failed",
        last_error: success ? null : result.errors.join("; ").slice(0, 2000),
        last_success_at: success ? finishedAt : undefined,
        last_failed_at: success ? undefined : finishedAt,
        next_run_at: nextRun,
        last_slot_key: gate.matched_slot_key,
      },
      loaded.scope,
    );

    return NextResponse.json({
      ok: success,
      skipped: false,
      reason: "executed",
      settings_source: gate.settings_source,
      organization_id: PRODUCTION_ORG_ID,
      target_ref: PRODUCTION_REF,
      vercel_wake_schedule: VERCEL_REMOVAL_CRON_WAKE_SCHEDULE,
      schedule: loadedScope,
      window: result.window,
      counts_before: result.counts_before,
      counts_after: result.counts_after,
      latest_shipment_date: result.latest_shipment_date,
      rebuild_valid: result.rebuild_valid,
      errors: result.errors,
      order_upload_id: result.order_fetch.upload_id,
      shipment_upload_id: result.shipment_fetch.upload_id,
      next_run_at: nextRun,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      const loaded = await loadProductionRemovalAutomationSettings();
      await persistRemovalCronRuntime(
        PRODUCTION_ORG_ID,
        PRODUCTION_STORE_ID,
        {
          last_run_at: new Date().toISOString(),
          last_run_status: "failed",
          last_error: msg.slice(0, 2000),
          last_failed_at: new Date().toISOString(),
        },
        loaded.scope,
      );
    } catch {
      /* best effort */
    }
    return NextResponse.json({ ok: false, error: msg, skipped: false }, { status: 500 });
  } finally {
    await lock.release();
  }
}
