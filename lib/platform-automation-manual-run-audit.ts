import { supabaseServer } from "./supabase-server";
import {
  manualRunAuditEntry,
  resolvePlatformAutomationAuditActor,
  writePlatformAutomationAuditLogs,
} from "./platform-automation-audit-log";

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
