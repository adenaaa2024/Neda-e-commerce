import { supabaseServer } from "./supabase-server";
import {
  apiCardCronAuditEntry,
  cronAuditEntry,
  manualRunAuditEntry,
  resolvePlatformAutomationAuditActor,
  writePlatformAutomationAuditLogs,
} from "./platform-automation-audit-log";

/** Best-effort audit for API card scheduled executor (reimbursements / settlement / finances). */
export async function auditApiCardCronEvent(args: {
  organizationId: string;
  storeId: string;
  automationType: "reimbursements_api" | "settlement_api" | "finances_archive_api";
  action: "cron_tick" | "cron_run";
  gate?: Record<string, unknown>;
  result?: Record<string, unknown>;
  source?: string;
}): Promise<void> {
  try {
    await writePlatformAutomationAuditLogs(supabaseServer, { actor_user_id: null, actor_email: null }, [
      apiCardCronAuditEntry(args),
    ]);
  } catch (err) {
    console.error("[auditApiCardCronEvent]", err);
  }
}

/** Best-effort audit for Vercel removal cron wake / execute. */
export async function auditRemovalCronEvent(args: {
  organizationId: string;
  storeId: string;
  action: "cron_tick" | "cron_run";
  gate?: Record<string, unknown>;
  result?: Record<string, unknown>;
}): Promise<void> {
  try {
    await writePlatformAutomationAuditLogs(supabaseServer, { actor_user_id: null, actor_email: null }, [
      cronAuditEntry(args),
    ]);
  } catch (err) {
    console.error("[auditRemovalCronEvent]", err);
  }
}

/** Best-effort audit for automation manual run / resume API routes. */
export async function auditPlatformAutomationManualRun(args: {
  organizationId: string;
  storeId: string;
  automationType: string;
  action: "run_now" | "resume";
  requestBody?: Record<string, unknown>;
  result?: Record<string, unknown>;
  route: string;
}): Promise<void> {
  try {
    const actor = await resolvePlatformAutomationAuditActor(supabaseServer);
    await writePlatformAutomationAuditLogs(supabaseServer, actor, [
      manualRunAuditEntry({
        organizationId: args.organizationId,
        storeId: args.storeId,
        automationType: args.automationType,
        action: args.action,
        body: {
          ...(args.requestBody ?? {}),
          route: args.route,
        },
        result: args.result,
        source: "automation_api_route",
      }),
    ]);
  } catch (err) {
    console.error("[auditPlatformAutomationManualRun]", err);
  }
}
