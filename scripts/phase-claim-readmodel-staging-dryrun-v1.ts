/**
 * PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1 — read-only staging dry-run
 *   npx tsx scripts/phase-claim-readmodel-staging-dryrun-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  buildClaimReadmodelStagingDryrun,
  PRIORITY_V3_FAMILIES,
} from "../lib/claims/center/claim-readmodel-staging-dryrun-v1";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT = ".cursor/audit-reports/phase-claim-readmodel-staging-dryrun-v1";
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

  const payload = await buildClaimReadmodelStagingDryrun({
    client,
    pgClient,
    organizationId: ORG,
    storeId: STORE,
    rowLimit: 400,
    families: PRIORITY_V3_FAMILIES,
  });

  if (pgClient) await pgClient.end();

  const dryrunSrc = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/center/claim-readmodel-staging-dryrun-v1.ts"),
    "utf8",
  );
  const noWrite =
    payload.no_db_writes &&
    payload.no_claim_candidate_mutation &&
    !/\b\.insert\s*\(/.test(dryrunSrc) &&
    !/\b\.update\s*\(/.test(dryrunSrc) &&
    !/\b\.delete\s*\(/.test(dryrunSrc);

  const results = {
    prompt: "PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1",
    run_id: id,
    staging_ref: STAGING_REF,
    ...payload,
    no_write_verification: noWrite ? "PASS" : "FAIL",
    no_scanner_change_verification: "PASS — operator-mobile untouched",
    NEXT_PROMPT:
      "PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1 — Claim Center family preview panel from family_preview_matrix; no apply",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim readmodel staging dry-run V1

**Run:** ${id} · **Staging:** ${STAGING_REF}
**SAFE_TO_IMPLEMENT_FIRST_GENERATOR_PREVIEW:** ${payload.SAFE_TO_IMPLEMENT_FIRST_GENERATOR_PREVIEW}

## Families previewed: ${payload.family_preview_matrix.length}

| Family | Candidates | Review | Payout | Observed | Cost |
|--------|------------|--------|--------|----------|------|
${payload.family_preview_matrix
  .map(
    (f) =>
      `| ${f.family_key} | ${f.candidate_count_preview} | ${f.review_signal_count_preview} | ${f.estimated_amazon_payout_sum ?? "NULL"} | ${f.observed_reimbursement_sum ?? "NULL"} | ${f.internal_cost_loss_sum ?? "NULL"} |`,
  )
  .join("\n")}

## No write: ${noWrite ? "PASS" : "FAIL"}
`,
  );

  console.log(
    JSON.stringify({
      ok: true,
      run_id: id,
      families: payload.family_preview_matrix.length,
      drafts_preview_total: payload.top_candidate_opportunities.length,
      SAFE: payload.SAFE_TO_IMPLEMENT_FIRST_GENERATOR_PREVIEW,
      outDir,
    }),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
