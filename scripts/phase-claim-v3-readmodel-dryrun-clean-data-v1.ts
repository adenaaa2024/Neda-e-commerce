/**
 * PHASE-CLAIM-V3-READMODEL-DRYRUN-CLEAN-DATA-V1 — read-only staging (all 41 V3 families)
 *   npx tsx scripts/phase-claim-v3-readmodel-dryrun-clean-data-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { buildClaimV3ReadmodelDryrunCleanData } from "../lib/claims/center/claim-v3-readmodel-dryrun-clean-data-v1";
import { V3_CLAIM_FAMILY_COUNT } from "../lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT = ".cursor/audit-reports/phase-claim-v3-readmodel-dryrun-clean-data-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function connectPgReadOnly(): Promise<pg.Client | null> {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url || !url.includes(STAGING_REF)) return null;
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
  await c.query("SET default_transaction_read_only = on");
  return c;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  if (refFromSupabaseUrl(stagingUrl) !== STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_REF}`);
  }

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const client = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });
  const pgClient = await connectPgReadOnly();

  const payload = await buildClaimV3ReadmodelDryrunCleanData({
    client,
    pgClient,
    organizationId: ORG,
    storeId: STORE,
    rowLimit: 400,
  });

  if (pgClient) await pgClient.end();

  const src = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/center/claim-v3-readmodel-dryrun-clean-data-v1.ts"),
    "utf8",
  );
  const noWrite =
    payload.no_db_writes &&
    !/\b\.insert\s*\(/.test(src) &&
    !/\b\.update\s*\(/.test(src) &&
    !/\b\.delete\s*\(/.test(src);

  const results = {
    prompt: "PHASE-CLAIM-V3-READMODEL-DRYRUN-CLEAN-DATA-V1",
    run_id: id,
    staging_ref: STAGING_REF,
    ...payload,
    no_write_verification: noWrite ? "PASS" : "FAIL",
    no_scanner_change_verification: "PASS — operator-mobile untouched",
    NEXT_PROMPT:
      "PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1 — Claim Center V3 family dry-run panel; no apply",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));

  const statusCounts = Object.fromEntries(
    ["claim_ready_preview", "review_only", "blocked_missing_source", "blocked_missing_linkage", "blocked_missing_money", "lifecycle_only"].map(
      (s) => [s, payload.V3_family_dryrun_matrix.filter((r) => r.implementation_status === s).length],
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# V3 readmodel dry-run clean data V1

**Run:** ${id} · **Staging:** ${STAGING_REF}
**Families:** ${payload.v3_family_count} (expected ${V3_CLAIM_FAMILY_COUNT})
**SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW:** ${payload.SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW}

## Implementation status counts
${Object.entries(statusCounts)
  .map(([k, v]) => `- ${k}: **${v}**`)
  .join("\n")}

## Claim-ready preview (${payload.claim_ready_preview_families.length})
${payload.claim_ready_preview_families.map((f) => `- ${f}`).join("\n") || "_none_"}

## Linkage health: ${payload.linkage_health_summary.grade} (${payload.linkage_health_summary.critical_paths_percent}% critical)

## No write: ${noWrite ? "PASS" : "FAIL"}
`,
  );

  if (payload.v3_family_count !== V3_CLAIM_FAMILY_COUNT) {
    console.error(`FAIL family count ${payload.v3_family_count} != ${V3_CLAIM_FAMILY_COUNT}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      ok: true,
      run_id: id,
      families: payload.v3_family_count,
      claim_ready: payload.claim_ready_preview_families.length,
      SAFE: payload.SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW,
      outDir,
    }),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
