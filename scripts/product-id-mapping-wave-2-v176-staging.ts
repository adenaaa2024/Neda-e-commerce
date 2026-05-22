/**
 * PRODUCT-ID-MAPPING-WAVE-2-V176 — exact identifier backfill on staging (partial tables).
 *
 *   npx tsx scripts/product-id-mapping-wave-2-v176-staging.ts --run-id=<id>
 *   npx tsx scripts/product-id-mapping-wave-2-v176-staging.ts --run-id=<id> --execute
 *   npx tsx scripts/product-id-mapping-wave-2-v176-staging.ts --skip-drafts
 *
 * Targets: amazon_returns, amazon_manage_fba_inventory, slip_contents,
 *          amazon_transactions, amazon_amazon_fulfilled_inventory (exact tiers only).
 * Then: claim_candidate_drafts materialize (V175 resolver) unless --skip-drafts.
 *
 * Forbidden: settlements, inventory_ledger, return_items, package_items, production.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  applyMaterializeProposals,
  runClaimResolverMaterializePass,
} from "../lib/claim-candidate-resolver-materialize";
import {
  assertPackageItemsForbidden,
  buildWave2TableConfig,
  countWave2TierEligible,
  ensureWave2AuditTable,
  executeWave2TierBackfill,
  probeTableCoverage,
  WAVE2_TARGET_ORDER,
  WAVE2_TIERS_BY_TABLE,
  type Wave2TierResult,
  type Wave2TargetTable,
} from "../lib/product-id-mapping-wave2-pg";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const FORBIDDEN_TABLES = [
  "amazon_settlements",
  "amazon_inventory_ledger",
  "return_items",
  "package_items",
] as const;

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

function tiersFilterArg(): Set<string> | null {
  const a = process.argv.find((x) => x.startsWith("--tiers="));
  if (!a) return null;
  return new Set(
    a
      .split("=")[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function tiersForTable(table: Wave2TargetTable, filter: Set<string> | null) {
  const base = WAVE2_TIERS_BY_TABLE[table];
  if (!filter) return base;
  return base.filter((t) => filter.has(String(t)));
}

function tablesArg(): Wave2TargetTable[] {
  const a = process.argv.find((x) => x.startsWith("--tables="));
  if (!a) return [...WAVE2_TARGET_ORDER];
  const names = a
    .split("=")[1]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Wave2TargetTable[];
  return names.filter((t) => WAVE2_TARGET_ORDER.includes(t));
}

function auditTableName(runId: string): string {
  return `product_id_mapping_v176_audit_${runId.replace(/[^a-z0-9]/gi, "_").slice(0, 32)}`;
}

async function probeClaims(client: pg.Client): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const t of ["claim_candidates", "claim_candidate_drafts"] as const) {
    const total = await client.query(`SELECT COUNT(*)::bigint AS c FROM public."${t}"`);
    const resolved = await client.query(
      `SELECT COUNT(*)::bigint AS c FROM public."${t}" WHERE resolved_product_id IS NOT NULL`,
    );
    const tot = Number(total.rows[0]?.c ?? 0);
    const res = Number(resolved.rows[0]?.c ?? 0);
    out[t] = {
      total: tot,
      resolved: res,
      unresolved: tot - res,
      coverage_pct: tot > 0 ? Math.round((res / tot) * 1000) / 10 : 100,
    };
  }
  return out;
}

function resolveSupabase(): { url: string; key: string } {
  const url =
    process.env.STAGING_SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    "";
  const key =
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  if (!url || !key) throw new Error("Missing staging Supabase URL or service role key.");
  return { url, key };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const includeDrafts = hasFlag("--include-drafts");
  const targetTables = tablesArg();
  const tiersFilter = tiersFilterArg();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/product-id-mapping-wave-2-v176",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    process.env.SUPABASE_DB_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  const stagingRef = getStagingProjectRef({ loadEnv: false });

  if (!dbUrl) {
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "FAIL", error: "DIRECT_POSTGRES_URL unset" }, null, 2),
    );
    process.exit(2);
  }

  if (ref !== STAGING_REF || stagingRef !== STAGING_REF) {
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        { run_id: runId, status: "FAIL", error: `staging ref mismatch: ${ref} / ${stagingRef}` },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '600s'`);

  const packageItemsExists = await assertPackageItemsForbidden(client);
  if (packageItemsExists) {
    await client.end();
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "FAIL", error: "package_items table exists (forbidden)" }, null, 2),
    );
    process.exit(2);
  }

  const coverageBefore: Record<string, unknown> = {};
  for (const t of targetTables) {
    const c = await probeTableCoverage(client, t);
    if (c) coverageBefore[t] = c;
  }
  if (includeDrafts || execute) {
    coverageBefore.claims = await probeClaims(client);
  }

  const tierDryRun: Array<{
    table: string;
    tier: string;
    eligible_exact: number;
  }> = [];
  const tierResults: Wave2TierResult[] = [];
  const auditTable = auditTableName(runId);

  if (execute) {
    await ensureWave2AuditTable(client, auditTable);
    for (const table of targetTables) {
      const cfg = await buildWave2TableConfig(client, table);
      if (!cfg) continue;
      await client.query("BEGIN");
      try {
        for (const tier of tiersForTable(table, tiersFilter)) {
          const updated = await executeWave2TierBackfill(client, cfg, tier, runId, auditTable);
          tierResults.push({ table, tier, eligible: updated, updated });
          tierDryRun.push({ table, tier: String(tier), eligible_exact: updated });
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } else {
    for (const table of targetTables) {
      const cfg = await buildWave2TableConfig(client, table);
      if (!cfg) {
        tierDryRun.push({ table, tier: "missing_table", eligible_exact: 0 });
        continue;
      }
      for (const tier of tiersForTable(table, tiersFilter)) {
        const n = await countWave2TierEligible(client, cfg, tier);
        tierDryRun.push({ table, tier: String(tier), eligible_exact: n });
      }
    }
  }

  const coverageAfter: Record<string, unknown> = {};
  for (const t of targetTables) {
    const c = await probeTableCoverage(client, t);
    if (c) coverageAfter[t] = c;
  }

  let draftMaterialize: Record<string, unknown> = { executed: false, skipped: !includeDrafts };
  if (execute && includeDrafts) {
    const supabase = createClient(resolveSupabase().url, resolveSupabase().key, {
      auth: { persistSession: false },
    });
    const { metrics, proposals } = await runClaimResolverMaterializePass(supabase, "claim_candidate_drafts", {
      onlyUnresolved: true,
    });
    const { applied, errors } = await applyMaterializeProposals(supabase, "claim_candidate_drafts", proposals);
    draftMaterialize = {
      executed: true,
      metrics,
      proposals_count: proposals.length,
      applied,
      errors: errors.slice(0, 20),
    };
    fs.writeFileSync(
      path.join(outDir, "draft-proposals-sample.json"),
      JSON.stringify(proposals.slice(0, 100), null, 2),
    );
  } else if (includeDrafts && !execute) {
    const supabase = createClient(resolveSupabase().url, resolveSupabase().key, {
      auth: { persistSession: false },
    });
    const { metrics, proposals } = await runClaimResolverMaterializePass(supabase, "claim_candidate_drafts", {
      onlyUnresolved: true,
      maxPages: 3,
    });
    draftMaterialize = {
      executed: false,
      sample_max_pages: 3,
      metrics,
      proposals_sample_count: proposals.length,
    };
  }

  if (includeDrafts || execute) {
    coverageAfter.claims = await probeClaims(client);
  }
  await client.end();

  const forbiddenNote = FORBIDDEN_TABLES.map((t) => ({ table: t, action: "skipped_by_policy" }));

  const summaryLines = [
    `# PRODUCT-ID-MAPPING-WAVE-2-V176`,
    ``,
    `**Run id:** \`${runId}\``,
    `**Mode:** ${execute ? "execute" : "dry-run"}`,
    `**Staging ref:** \`${STAGING_REF}\``,
  ];

  for (const t of targetTables) {
    const before = coverageBefore[t] as { coverage_pct?: number; unresolved?: number } | undefined;
    const after = coverageAfter[t] as { coverage_pct?: number; unresolved?: number } | undefined;
    if (before && after) {
      summaryLines.push(
        `- **${t}:** ${before.coverage_pct}% → ${after.coverage_pct}% (unresolved ${before.unresolved} → ${after.unresolved})`,
      );
    }
  }

  const claimsBefore = coverageBefore.claims as Record<string, { coverage_pct: number }>;
  const claimsAfter = coverageAfter.claims as Record<string, { coverage_pct: number }>;
  if (claimsBefore?.claim_candidate_drafts && claimsAfter?.claim_candidate_drafts) {
    summaryLines.push(
      `- **claim_candidate_drafts:** ${claimsBefore.claim_candidate_drafts.coverage_pct}% → ${claimsAfter.claim_candidate_drafts.coverage_pct}%`,
    );
  }
  if (claimsBefore?.claim_candidates && claimsAfter?.claim_candidates) {
    summaryLines.push(
      `- **claim_candidates:** ${claimsBefore.claim_candidates.coverage_pct}% → ${claimsAfter.claim_candidates.coverage_pct}%`,
    );
  }

  fs.writeFileSync(path.join(outDir, "summary.md"), summaryLines.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "tier-dry-run.json"), JSON.stringify(tierDryRun, null, 2));
  fs.writeFileSync(path.join(outDir, "coverage-before.json"), JSON.stringify(coverageBefore, null, 2));
  fs.writeFileSync(path.join(outDir, "coverage-after.json"), JSON.stringify(coverageAfter, null, 2));
  fs.writeFileSync(
    path.join(outDir, "constraints.md"),
    [
      `# Constraints`,
      ``,
      `- Exact tiers only: FNSKU; SKU+ASIN; SKU; ASIN; UPC on slip_contents`,
      `- Forbidden skipped: ${FORBIDDEN_TABLES.join(", ")}`,
      `- No title/OCR/fuzzy; no product auto-create; no production; no DDL`,
    ].join("\n"),
  );

  if (execute) {
    fs.writeFileSync(path.join(outDir, "tier-execute-results.json"), JSON.stringify(tierResults, null, 2));
    fs.writeFileSync(path.join(outDir, "draft-materialize.json"), JSON.stringify(draftMaterialize, null, 2));
  }

  const status = packageItemsExists ? "FAIL" : "PASS";
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_id: "PRODUCT-ID-MAPPING-WAVE-2-V176",
        run_id: runId,
        status,
        staging_ref: STAGING_REF,
        execute,
        audit_table: execute ? auditTable : null,
        tier_results: tierResults,
        forbidden_skipped: forbiddenNote,
        draft_materialize: draftMaterialize,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ run_id: runId, status, outDir, execute, tier_results: tierResults }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
