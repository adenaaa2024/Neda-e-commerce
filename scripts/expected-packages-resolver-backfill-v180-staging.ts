/**
 * EXPECTED-PACKAGES-RESOLVER-BACKFILL-V180 — staging DDL + tiered backfill.
 *
 *   npx tsx scripts/expected-packages-resolver-backfill-v180-staging.ts --run-id=<id>
 *   npx tsx scripts/expected-packages-resolver-backfill-v180-staging.ts --run-id=<id> --execute
 *   npx tsx scripts/expected-packages-resolver-backfill-v180-staging.ts --tiers=1,2,4
 *
 * Requires: .cursor/operator-approvals/expected-packages-resolver-backfill-v180-approval.md
 * Forbidden: production, package_items, fuzzy/title/OCR, return_items mutations.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { isExpectedPackagesResolverBackfillV180Approved } from "../lib/expected-packages-resolver-approval";
import {
  applyExpectedPackagesResolverDdl,
  assertPackageItemsForbidden,
  countExpectedPackagesTierEligible,
  initExpectedPackagesAsinExpr,
  EP_DEFAULT_TIERS,
  EP_TIER_ORDER,
  ensureExpectedPackagesAuditTable,
  executeExpectedPackagesTierBackfill,
  probeExpectedPackagesCoverage,
  type ExpectedPackagesTier,
} from "../lib/expected-packages-resolver-backfill-pg";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function tiersArg(): ExpectedPackagesTier[] {
  const a = process.argv.find((x) => x.startsWith("--tiers="));
  if (!a) return [...EP_DEFAULT_TIERS];
  const names = a
    .split("=")[1]!
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => EP_TIER_ORDER.includes(n as ExpectedPackagesTier));
  return names.length ? (names as ExpectedPackagesTier[]) : [...EP_DEFAULT_TIERS];
}

function auditTableName(runId: string): string {
  return `expected_packages_resolver_v180_audit_${runId.replace(/[^a-z0-9]/gi, "_").slice(0, 32)}`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const tiers = tiersArg();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/expected-packages-resolver-backfill-v180",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  if (!isExpectedPackagesResolverBackfillV180Approved()) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      "# Blockers\n\n**FAIL:** Operator approval flag not true — see `expected-packages-resolver-backfill-v180-approval.md`.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "BLOCKED", error: "approval_required" }, null, 2),
    );
    console.error("BLOCKED: expected-packages-resolver-backfill-v180 approval not granted.");
    process.exit(2);
  }

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  const stagingRef = getStagingProjectRef({ loadEnv: false });

  if (!dbUrl || ref !== STAGING_REF || stagingRef !== STAGING_REF) {
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "FAIL", error: "staging ref guard" }, null, 2),
    );
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '300s'`);
  await client.query(`SET lock_timeout = '60s'`);

  if (await assertPackageItemsForbidden(client)) {
    await client.end();
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      "# Blockers\n\n**FAIL:** `package_items` exists (forbidden).\n",
    );
    process.exit(2);
  }

  await initExpectedPackagesAsinExpr(client);
  const coverageBefore = await probeExpectedPackagesCoverage(client);
  const tierDryRun: Array<{ tier: number; eligible_exact: number }> = [];
  const tierResults: Array<{ tier: number; updated: number }> = [];
  const auditTable = auditTableName(runId);
  let ddlApplied = false;

  if (execute) {
    ddlApplied = await applyExpectedPackagesResolverDdl(client);
    await ensureExpectedPackagesAuditTable(client, auditTable);
    for (const tier of tiers) {
      await client.query("BEGIN");
      try {
        const updated = await executeExpectedPackagesTierBackfill(client, tier, runId, auditTable);
        tierResults.push({ tier, updated });
        tierDryRun.push({ tier, eligible_exact: updated });
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } else {
    const hasCol = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'expected_packages' AND column_name = 'resolved_product_id'`,
    );
    if ((hasCol.rowCount ?? 0) === 0) {
      tierDryRun.push({ tier: 0, eligible_exact: 0 });
    } else {
      for (const tier of tiers) {
        const n = await countExpectedPackagesTierEligible(client, tier);
        tierDryRun.push({ tier, eligible_exact: n });
      }
    }
  }

  const coverageAfter = await probeExpectedPackagesCoverage(client);
  await client.end();

  fs.writeFileSync(
    path.join(outDir, "ddl-applied.md"),
    [
      "# DDL",
      "",
      execute
        ? "**Applied** on staging (idempotent ALTER + index)."
        : "**Not applied** (dry-run). Columns must exist before execute backfill.",
      "",
      "See `supabase/migrations/20260820120000_expected_packages_resolver_columns.sql`.",
    ].join("\n"),
  );

  fs.writeFileSync(path.join(outDir, "tier-dry-run.json"), JSON.stringify(tierDryRun, null, 2));
  if (execute) {
    fs.writeFileSync(path.join(outDir, "tier-execute-results.json"), JSON.stringify(tierResults, null, 2));
  }
  fs.writeFileSync(
    path.join(outDir, "coverage-before.json"),
    JSON.stringify(coverageBefore, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "coverage-after.json"),
    JSON.stringify(coverageAfter, null, 2),
  );

  const summary = [
    `# EXPECTED-PACKAGES-RESOLVER-BACKFILL-V180`,
    ``,
    `**Run:** ${runId}`,
    `**Mode:** ${execute ? "execute" : "dry-run"}`,
    `**Staging:** \`${STAGING_REF}\``,
    `**Tiers:** ${tiers.join(", ")}`,
    ``,
    coverageBefore && coverageAfter
      ? `- **expected_packages:** ${coverageBefore.coverage_pct}% → ${coverageAfter.coverage_pct}% (${coverageBefore.resolved} → ${coverageAfter.resolved} / ${coverageAfter.total})`
      : "",
    execute
      ? `- **Rows updated:** ${tierResults.reduce((a, t) => a + t.updated, 0)}`
      : `- **Eligible (dry-run):** ${tierDryRun.reduce((a, t) => a + t.eligible_exact, 0)}`,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "summary.md"), summary + "\n");

  fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blockers\n\nNone.\n");

  const status = "PASS";
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_id: "EXPECTED-PACKAGES-RESOLVER-BACKFILL-V180",
        run_id: runId,
        status,
        execute,
        ddl_applied: ddlApplied,
        staging_ref: STAGING_REF,
        tiers,
        tier_results: tierResults,
        coverage_before: coverageBefore,
        coverage_after: coverageAfter,
        audit_table: execute ? auditTable : null,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        run_id: runId,
        status,
        execute,
        outDir,
        coverage_before: coverageBefore,
        coverage_after: coverageAfter,
        tier_results: tierResults,
        tier_dry_run: tierDryRun,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
