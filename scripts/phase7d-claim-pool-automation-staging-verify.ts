/**
 * PHASE-7D staging verification — exercises the exact automation core used by the
 * manual-run action and cron route (settings round-trip, gated dry-run, runtime
 * persistence, audit log write). DRY-RUN ONLY: no claim_candidates writes.
 *   npx tsx scripts/phase7d-claim-pool-automation-staging-verify.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  loadClaimPoolGenerationSchedule,
  persistClaimPoolCronRuntime,
  runClaimPoolGeneration,
  runStatusFromOutcome,
} from "../lib/claims/intake/claim-pool-automation-run";
import { computeClaimPoolGenerationNextRun } from "../lib/platform-automation-schedule";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase7d-claim-pool-automation";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  if (refFromSupabaseUrl(url) !== STAGING_REF) {
    throw new Error(`Expected staging ref ${STAGING_REF}; refusing to run.`);
  }
  const client = createClient(url, key, { auth: { persistSession: false } });

  const before = await client.from("claim_candidates").select("id", { count: "exact", head: true });
  const beforeCount = before.count ?? -1;

  // 1) Settings round-trip (defaults when scope has no claim_pool_generation yet).
  const { schedule } = await loadClaimPoolGenerationSchedule(client, ORG, STORE);

  // 2) Gated dry-run through the shared automation core (selected sources + purchased gate sim).
  const gatedSchedule = {
    ...schedule,
    enabled_source_kinds: ["reimbursement", "inventory_ledger", "settlement"],
    purchased_source_kinds: { settlement: false },
    rolling_days: 365,
  };
  const outcome = await runClaimPoolGeneration({
    client,
    organizationId: ORG,
    storeId: STORE,
    schedule: gatedSchedule,
    requestedSources: null,
    apply: false,
  });

  // 3) Persist runtime patch + audit row (the same writes the action/cron perform).
  const finishedAt = new Date().toISOString();
  await persistClaimPoolCronRuntime(client, ORG, STORE, {
    last_run_at: finishedAt,
    last_run_status: runStatusFromOutcome(outcome),
    last_error: outcome.error,
    last_success_at: finishedAt,
  });
  const { error: auditErr } = await client.from("platform_automation_audit_log").insert({
    organization_id: ORG,
    store_id: STORE,
    automation_type: "claim_pool_generation",
    action: "run_now",
    actor_user_id: null,
    actor_email: "phase7d-staging-verify",
    before_json: { sources: outcome.effective_sources, window: outcome.window, mode: outcome.mode },
    after_json: { run_id: outcome.run_id, counts: outcome.counts, ok: outcome.ok },
    metadata: { source: "phase7d_staging_verify_script" },
  });

  // 4) Re-read: runtime persisted + next run computed + audit row visible.
  const { schedule: after } = await loadClaimPoolGenerationSchedule(client, ORG, STORE);
  const { data: auditRow } = await client
    .from("platform_automation_audit_log")
    .select("id, action, automation_type, created_at")
    .eq("automation_type", "claim_pool_generation")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const afterPool = await client.from("claim_candidates").select("id", { count: "exact", head: true });
  const afterCount = afterPool.count ?? -1;

  const report = {
    audit: "PHASE-7D-CLAIM-POOL-AUTOMATION-STAGING-VERIFY",
    ran_at: finishedAt,
    settings_round_trip: {
      defaults_loaded: schedule.enabled === false && schedule.scheduled_mode === "dry_run",
      enabled_source_kinds_count: schedule.enabled_source_kinds.length,
    },
    gating: {
      effective_sources: outcome.effective_sources,
      blocked_sources: outcome.blocked_sources,
      purchased_gate_blocked_settlement: outcome.blocked_sources.some(
        (b) => b.source_kind === "settlement" && b.reason === "not_purchased_pro_feature",
      ),
    },
    dry_run: {
      mode: outcome.mode,
      ok: outcome.ok,
      window: outcome.window,
      counts: outcome.counts,
      per_source: outcome.per_source,
    },
    runtime_persisted: {
      last_run_at: after.cron_runtime?.last_run_at ?? null,
      last_run_status: after.cron_runtime?.last_run_status ?? "never",
      next_run_at_computed: computeClaimPoolGenerationNextRun({ ...after, enabled: true })?.toISOString() ?? null,
    },
    audit_log: {
      insert_error: auditErr?.message ?? null,
      latest_row: auditRow ?? null,
    },
    pool_unchanged: { before: beforeCount, after: afterCount, no_writes: beforeCount === afterCount },
  };

  const stamp = finishedAt.replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, stamp);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  const pass =
    report.settings_round_trip.defaults_loaded &&
    report.gating.purchased_gate_blocked_settlement &&
    outcome.mode === "dry_run" &&
    report.pool_unchanged.no_writes &&
    !auditErr &&
    after.cron_runtime?.last_run_at != null;
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
