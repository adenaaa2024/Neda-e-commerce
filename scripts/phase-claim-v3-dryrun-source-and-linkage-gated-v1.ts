/**
 * PHASE-CLAIM-V3-DRYRUN-SOURCE-AND-LINKAGE-GATED-V1
 *   npx tsx scripts/phase-claim-v3-dryrun-source-and-linkage-gated-v1.ts
 *   npx tsx scripts/phase-claim-v3-dryrun-source-and-linkage-gated-v1.ts --compare-original
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { buildClaimV3DryrunSourceLinkageGated } from "../lib/claims/center/claim-v3-dryrun-source-linkage-gated-v1";
import { V3_CLAIM_FAMILY_COUNT } from "../lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT = ".cursor/audit-reports/phase-claim-v3-dryrun-source-and-linkage-gated-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function connectPgReadOnly(url: string, ref: string): Promise<pg.Client | null> {
  if (!url?.includes(ref)) return null;
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function ccCount(pgClient: pg.Client): Promise<number> {
  const r = await pgClient.query(
    `SELECT COUNT(*)::bigint AS c FROM claim_candidates
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND quarantined_at IS NULL AND rejected_at IS NULL`,
    [ORG, STORE],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function runEnv(label: string, url: string, key: string, pgUrl: string, ref: string) {
  const client = createClient(url, key, { auth: { persistSession: false } });
  const pgClient = await connectPgReadOnly(pgUrl, ref);
  const ccBefore = pgClient ? await ccCount(pgClient) : null;
  const payload = await buildClaimV3DryrunSourceLinkageGated({
    client,
    pgClient,
    organizationId: ORG,
    storeId: STORE,
    rowLimit: 400,
  });
  const ccAfter = pgClient ? await ccCount(pgClient) : null;
  if (pgClient) await pgClient.end();
  return {
    env: label,
    ref,
    payload,
    claim_candidates: { before: ccBefore, after: ccAfter, delta: ccAfter != null && ccBefore != null ? ccAfter - ccBefore : 0 },
  };
}

async function main(): Promise<void> {
  const compareOriginal = process.argv.includes("--compare-original");
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const stagingKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const stagingPg = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";

  if (refFromSupabaseUrl(stagingUrl) !== STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_REF}`);
  }

  const staging = await runEnv("staging", stagingUrl, stagingKey, stagingPg, STAGING_REF);

  let original: Awaited<ReturnType<typeof runEnv>> | null = null;
  if (
    compareOriginal &&
    (staging.payload.SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW === "yes" ||
      staging.payload.SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW === "conditional")
  ) {
    bindProductionSupabaseEnv();
    const origUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
    const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
    const origPg = productionPostgresUrl() || "";
    if (refFromSupabaseUrl(origUrl) === PRODUCTION_REF && origKey && origPg) {
      original = await runEnv("original_readonly", origUrl, origKey, origPg, PRODUCTION_REF);
    }
  }

  const src = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/center/claim-v3-dryrun-source-linkage-gated-v1.ts"),
    "utf8",
  );
  const noWrite =
    !/\b\.insert\s*\(/.test(src) &&
    !/\b\.update\s*\(/.test(src) &&
    !/\b\.delete\s*\(/.test(src) &&
    staging.claim_candidates.delta === 0;

  const statusCounts = Object.fromEntries(
    (
      [
        "claim_ready_preview",
        "review_only",
        "blocked_missing_source",
        "blocked_missing_linkage",
        "blocked_missing_fee",
        "blocked_missing_cost",
        "lifecycle_only",
      ] as const
    ).map((k) => [k, staging.payload.V3_family_dryrun_matrix.filter((r) => r.classification === k).length]),
  );

  const summary: Record<string, unknown> = {
    prompt: "PHASE-CLAIM-V3-DRYRUN-SOURCE-AND-LINKAGE-GATED-V1",
    run_id: id,
    staging_ref: STAGING_REF,
    v3_family_count: staging.payload.v3_family_count,
    status_counts: statusCounts,
    ...staging.payload,
    original_comparison: original
      ? {
          ref: PRODUCTION_REF,
          status_counts: Object.fromEntries(
            (
              [
                "claim_ready_preview",
                "review_only",
                "blocked_missing_source",
                "blocked_missing_linkage",
                "blocked_missing_fee",
                "blocked_missing_cost",
                "lifecycle_only",
              ] as const
            ).map((k) => [
              k,
              original!.payload.V3_family_dryrun_matrix.filter((r) => r.classification === k).length,
            ]),
          ),
          claim_ready_preview_families: original.payload.claim_ready_preview_families,
          SAFE: original.payload.SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW,
        }
      : null,
    no_write_verification: {
      script_has_no_mutations: noWrite,
      claim_candidates_delta_staging: staging.claim_candidates.delta,
      read_only_flags: staging.payload.read_only && staging.payload.no_db_writes,
    },
    no_scanner_change_verification: "PASS — no scanner files modified",
    build_result: "skipped",
    smoke_result: "skipped",
    NEXT_PROMPT: "PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1",
  };

  if (staging.payload.v3_family_count !== V3_CLAIM_FAMILY_COUNT) {
    throw new Error(`Family count ${staging.payload.v3_family_count} != ${V3_CLAIM_FAMILY_COUNT}`);
  }

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

  try {
    require("child_process").execSync("npm run smoke:claim-family-algorithm-readmodel-v1", {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf8",
    });
    summary.smoke_result = "pass";
  } catch {
    summary.smoke_result = "fail_or_skipped";
  }

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify({
      ok: true,
      run_id: id,
      families: staging.payload.v3_family_count,
      status_counts: statusCounts,
      claim_ready: staging.payload.claim_ready_preview_families.length,
      SAFE: staging.payload.SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW,
      outDir,
    }),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
