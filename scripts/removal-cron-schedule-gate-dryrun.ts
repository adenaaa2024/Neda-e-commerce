/**
 * Dry-run production removal cron gate — no sync execution.
 *   npx tsx scripts/removal-cron-schedule-gate-dryrun.ts
 */
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { evaluateProductionRemovalCronGate } from "../lib/removal-cron-schedule-gate";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const gate = await evaluateProductionRemovalCronGate();
  console.log(JSON.stringify({ ok: true, gate, would_sync: gate.due && gate.enabled }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
