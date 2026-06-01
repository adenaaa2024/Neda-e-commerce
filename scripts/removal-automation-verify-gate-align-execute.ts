/**
 * REMOVAL-AUTOMATION-VERIFY-GATE-ALIGN — patch verify + burn-in retry (skip fetch/sync)
 *
 *   npx tsx scripts/removal-automation-verify-gate-align-execute.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/removal-automation-verify-gate-align";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function duplicateEpCheck(): Promise<{ dup_remainder: number; dup_business_key: number }> {
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const dupRem = await client.query(
    `SELECT count(*)::int AS c FROM (
       SELECT source_detail_row_id FROM public.expected_packages
       WHERE organization_id=$1::uuid AND build_source='detail_remainder'
       GROUP BY source_detail_row_id HAVING count(*)>1
     ) x`,
    [ORG_ID],
  );
  const dupBiz = await client.query(
    `SELECT count(*)::int AS c FROM (
       SELECT source_detail_row_id, source_shipment_row_id, build_source, allocation_group_key
       FROM public.expected_packages
       WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')
       GROUP BY 1,2,3,4 HAVING count(*)>1
     ) x`,
    [ORG_ID],
  );
  await client.end();
  return {
    dup_remainder: (dupRem.rows[0] as { c: number }).c,
    dup_business_key: (dupBiz.rows[0] as { c: number }).c,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  const filesChanged = [
    "lib/removal/ep-allocation-mismatch-breakdown.ts",
    "scripts/sp-api-removal-reports-domain-sync-execute.ts",
    "scripts/removal-quantity-allocation-validation.ts",
    "scripts/removal-post-sync-resolver-reconcile.ts",
    "scripts/removal-automation-orchestrator.ts",
    "scripts/removal-daily-automation-apply-burnin-staging.ts",
  ];

  let typecheckOk = false;
  try {
    execSync("npx tsc --noEmit -p tsconfig.json", { stdio: "pipe", cwd: process.cwd() });
    typecheckOk = true;
  } catch (e) {
    fs.writeFileSync(
      path.join(outDir, "typecheck-error.txt"),
      String((e as { stdout?: Buffer; stderr?: Buffer }).stderr ?? e),
    );
  }

  const verifyRunId = `${runId}-verify-probe`;
  const verifyRes = spawnSync(
    "npx",
    ["tsx", "scripts/removal-quantity-allocation-validation.ts", `--run-id=${verifyRunId}`],
    { cwd: process.cwd(), env: process.env, shell: true, encoding: "utf8" },
  );

  const verifyManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/removal-quantity-allocation-validation",
    verifyRunId,
    "manifest.json",
  );
  const verifyManifest = fs.existsSync(verifyManifestPath)
    ? (JSON.parse(fs.readFileSync(verifyManifestPath, "utf8")) as Record<string, unknown>)
    : null;

  process.env.REMOVAL_AUTOMATION_CONFIRM_APPLY = "true";
  const burninRunId = `${runId}-burnin`;
  const burninRes = spawnSync(
    "npx",
    [
      "tsx",
      "scripts/removal-daily-automation-apply-burnin-staging.ts",
      "--apply",
      "--skip-fetch",
      "--skip-domain-sync",
      `--run-id=${burninRunId}`,
    ],
    { cwd: process.cwd(), env: process.env, shell: true, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );

  const orchRunId = `${burninRunId}-orch`;
  const orchManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/removal-automation-run",
    orchRunId,
    "manifest.json",
  );
  const orchManifest = fs.existsSync(orchManifestPath)
    ? (JSON.parse(fs.readFileSync(orchManifestPath, "utf8")) as Record<string, unknown>)
    : null;

  const resolverManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/removal-post-sync-resolver-reconcile",
    `${orchRunId}-resolver`,
    "manifest.json",
  );
  const resolverManifest = fs.existsSync(resolverManifestPath)
    ? (JSON.parse(fs.readFileSync(resolverManifestPath, "utf8")) as Record<string, unknown>)
    : null;

  const dupBefore = await duplicateEpCheck();

  const verifyPass = verifyManifest?.allocation_contract_valid === true;
  const orchPass = orchManifest?.status === "PASS";
  const resolverRan = Boolean(resolverManifest);
  const resolverPass = resolverManifest?.status === "PASS" || resolverManifest?.status === "COMPLETE";

  fs.writeFileSync(
    path.join(outDir, "gate-align-report.md"),
    [
      "# REMOVAL AUTOMATION VERIFY GATE ALIGN",
      "",
      `Run: \`${runId}\` · Branch: \`${branch}\` · Staging: \`${STAGING_REF}\``,
      "",
      "## Files changed",
      "",
      ...filesChanged.map((f) => `- \`${f}\``),
      "",
      "## Build / test",
      "",
      `| Check | Result |`,
      `|-------|--------|`,
      `| tsc --noEmit | **${typecheckOk ? "PASS" : "FAIL"}** |`,
      "",
      "## Verify probe (post-patch)",
      "",
      verifyManifest
        ? [
            `- allocation_contract_valid: **${verifyManifest.allocation_contract_valid}**`,
            `- total mismatch: **${verifyManifest.live_vs_sim_mismatch_details}**`,
            `- overflow: **${verifyManifest.live_vs_sim_overflow_mismatch}**`,
            `- non-overflow: **${verifyManifest.live_vs_sim_non_overflow_mismatch}**`,
          ].join("\n")
        : "- verify manifest missing",
      "",
      "## Burn-in (--skip-fetch --skip-domain-sync)",
      "",
      `- exit: **${burninRes.status}**`,
      `- orchestrator status: **${orchManifest?.status ?? "unknown"}**`,
      "",
      "## Resolver",
      "",
      resolverManifest
        ? `- status: **${resolverManifest.status}** · applied: **${resolverManifest.applied_count ?? resolverManifest.queue_applied ?? "see manifest"}**`
        : "- resolver manifest not found",
      "",
      "## Duplicate EP check",
      "",
      `- duplicate remainder detail lines: **${dupBefore.dup_remainder}**`,
      `- duplicate business-key groups: **${dupBefore.dup_business_key}**`,
      "",
      "## Next automation step",
      "",
      orchPass && resolverRan
        ? "REMOVAL-DAILY-AUTOMATION-MONITOR — enable cron dry-run schedule only (do not set REMOVAL_AUTOMATION_APPLY_ENABLED on cron until operator sign-off)"
        : "REMOVAL-DAILY-AUTOMATION-DIAGNOSE — inspect step-results.json blockers",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-AUTOMATION-VERIFY-GATE-ALIGN",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        status: verifyPass && orchPass && resolverRan ? "PASS" : "PARTIAL",
        typecheck_ok: typecheckOk,
        files_changed: filesChanged,
        verify_probe: verifyManifest,
        burnin_exit: burninRes.status,
        orchestrator: orchManifest,
        resolver: resolverManifest,
        duplicate_ep: dupBefore,
        exact_next_prompt: orchPass
          ? "REMOVAL-DAILY-AUTOMATION-MONITOR — cron dry-run only; no apply secret on schedule"
          : "REMOVAL-DAILY-AUTOMATION-DIAGNOSE",
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: verifyPass && orchPass,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        verify_pass: verifyPass,
        orch_pass: orchPass,
        resolver_ran: resolverRan,
        duplicate_ep: dupBefore,
      },
      null,
      2,
    ),
  );

  if (!verifyPass || !orchPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
