import { NextResponse } from "next/server";

import {
  loadClaimPoolGenerationSchedule,
  persistClaimPoolCronRuntime,
  runClaimPoolGeneration,
  runStatusFromOutcome,
} from "@/lib/claims/intake/claim-pool-automation-run";
import { evaluateDailyScheduleDue } from "@/lib/platform-automation-scheduler-due";
import { parseAutomationPersisted } from "@/lib/platform-automation-scope-storage";
import { writePlatformAutomationAuditLogs } from "@/lib/platform-automation-audit-log";
import { supabaseServer } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

function slotKey(hourUtc: number): string {
  return `${new Date().toISOString().slice(0, 10)}T${String(hourUtc).padStart(2, "0")}Z`;
}

/**
 * Phase 7D — claim pool generation scheduler (wake route; business schedule from DB).
 * Per scope: enabled + due slot + not-already-ran gate, then runClaimPoolGeneration
 * in the configured mode. Production apply additionally requires
 * CLAIM_POOL_GENERATION_ALLOW_APPLY=true (never applies automatically without it).
 */
export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.ENABLE_CLAIM_POOL_GENERATION_CRON !== "true") {
    return NextResponse.json(
      { ok: false, error: "ENABLE_CLAIM_POOL_GENERATION_CRON is not true", code: "cron_disabled" },
      { status: 503 },
    );
  }

  const { data } = await supabaseServer
    .from("platform_settings")
    .select("automation_settings")
    .eq("id", true)
    .maybeSingle();
  const doc = parseAutomationPersisted(
    (data as { automation_settings?: unknown } | null)?.automation_settings,
  );

  const allowApply = process.env.CLAIM_POOL_GENERATION_ALLOW_APPLY === "true";
  const results: Array<Record<string, unknown>> = [];

  for (const scopeKey of Object.keys(doc.scopes)) {
    const [organizationId, storeId] = scopeKey.split(":");
    if (!organizationId || !storeId) continue;

    const { schedule } = await loadClaimPoolGenerationSchedule(supabaseServer, organizationId, storeId);
    if (!schedule.enabled) {
      results.push({ scope: scopeKey, skipped: true, reason: "schedule_disabled" });
      continue;
    }

    const due = evaluateDailyScheduleDue(true, schedule.run_hours_utc);
    const currentSlot = slotKey(due.current_hour_utc);
    if (!due.due) {
      results.push({ scope: scopeKey, skipped: true, reason: due.reason, next_run_at: due.next_run_at });
      continue;
    }
    if (schedule.cron_runtime?.last_slot_key === currentSlot) {
      results.push({ scope: scopeKey, skipped: true, reason: "slot_already_ran", slot: currentSlot });
      continue;
    }

    const apply = schedule.scheduled_mode === "apply" && allowApply;
    const startedAt = new Date().toISOString();
    await persistClaimPoolCronRuntime(supabaseServer, organizationId, storeId, {
      last_run_at: startedAt,
      last_run_status: "running",
      last_error: null,
      last_slot_key: currentSlot,
    });

    const outcome = await runClaimPoolGeneration({
      client: supabaseServer,
      organizationId,
      storeId,
      schedule,
      apply,
      runKind: "scheduled",
    });

    const finishedAt = new Date().toISOString();
    const status = runStatusFromOutcome(outcome);
    await persistClaimPoolCronRuntime(supabaseServer, organizationId, storeId, {
      last_run_at: finishedAt,
      last_run_status: status,
      last_error: outcome.error,
      last_success_at: status === "success" ? finishedAt : undefined,
      last_failed_at: status === "failed" ? finishedAt : undefined,
      last_slot_key: currentSlot,
    });

    await writePlatformAutomationAuditLogs(
      supabaseServer,
      { actor_user_id: null, actor_email: null },
      [
        {
          organization_id: organizationId,
          store_id: storeId,
          automation_type: "claim_pool_generation",
          action: "cron_run",
          before_json: {
            slot: currentSlot,
            scheduled_mode: schedule.scheduled_mode,
            apply_env_gate: allowApply,
          },
          after_json: {
            run_id: outcome.run_id,
            ok: outcome.ok,
            mode: outcome.mode,
            window: outcome.window,
            source_kinds: outcome.effective_sources,
            counts: outcome.counts,
            error: outcome.error,
          },
          metadata: { source: "cron", route: "/api/cron/claim-pool-generation" },
        },
      ],
    );

    results.push({
      scope: scopeKey,
      skipped: false,
      mode: outcome.mode,
      run_id: outcome.run_id,
      counts: outcome.counts,
      error: outcome.error,
    });
  }

  return NextResponse.json({ ok: true, scopes_evaluated: Object.keys(doc.scopes).length, results });
}
