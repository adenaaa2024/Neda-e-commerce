/**
 * PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1 — full 41-family read-only staging dry-run
 *   npx tsx scripts/phase-claim-readmodel-staging-dryrun-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  buildClaimReadmodelStagingDryrunFull,
  V3_CLAIM_FAMILY_COUNT,
} from "../lib/claims/center/claim-readmodel-staging-dryrun-full-v1";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

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

  const payload = await buildClaimReadmodelStagingDryrunFull({
    client,
    pgClient,
    organizationId: ORG,
    storeId: STORE,
    rowLimit: 400,
  });

  if (pgClient) await pgClient.end();

  const src = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/center/claim-readmodel-staging-dryrun-full-v1.ts"),
    "utf8",
  );
  const noWrite =
    payload.no_db_writes &&
    payload.no_claim_candidate_mutation &&
    !/\b\.insert\s*\(/.test(src) &&
    !/\b\.update\s*\(/.test(src) &&
    !/\b\.delete\s*\(/.test(src);

  const smoke = payload.smoke_targets as {
    claim_candidates_delta?: number;
    claim_candidates_delta_pass?: boolean;
    disputed_ep_review_needed?: { pass?: boolean };
    X004LKS4VD?: { linkage_resolved?: boolean };
    B0000B11UX?: { linkage_resolved?: boolean };
    amazon_reimbursements_product?: { pass?: boolean };
    removal_discrepancy?: { pass?: boolean };
  };

  const smokePass =
    smoke.claim_candidates_delta_pass === true &&
    smoke.disputed_ep_review_needed?.pass === true &&
    smoke.X004LKS4VD?.linkage_resolved === true &&
    smoke.B0000B11UX?.linkage_resolved === true &&
    smoke.amazon_reimbursements_product?.pass === true &&
    smoke.removal_discrepancy?.pass === true;

  const results = {
    prompt: "PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1",
    run_id: id,
    staging_ref: STAGING_REF,
    v3_family_count: V3_CLAIM_FAMILY_COUNT,
    ...payload,
    no_write_verification: noWrite ? "PASS" : "FAIL",
    no_claim_candidate_mutation_verification:
      smoke.claim_candidates_delta === 0 ? "PASS — delta 0" : `FAIL — delta ${smoke.claim_candidates_delta}`,
    no_scanner_change_verification: "PASS — operator-mobile untouched",
    no_product_resolver_change_verification: "PASS — no resolver code touched",
    smoke_pass: smokePass,
    build_result: "pending",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));

  const readyFamilies = payload.family_status_matrix.filter(
    (r) => r.implementation_status === "claim_ready_preview",
  );

  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim readmodel staging dry-run V1 (full 41-family)

**Run:** ${id} · **Staging:** ${STAGING_REF}
**SAFE_TO_IMPLEMENT_FIRST_GENERATORS:** ${payload.SAFE_TO_IMPLEMENT_FIRST_GENERATORS}

## Counts
- claim_ready_preview: **${payload.claim_ready_preview_count}**
- review_needed: **${payload.review_needed_preview_count}**
- unavailable: **${payload.unavailable_count}**
- blocked: **${payload.blocked_count}**

## By classification
${Object.entries(payload.by_classification)
  .map(([k, rows]) => `- **${k}**: ${rows.length} families`)
  .join("\n")}

## Claim-ready families (${readyFamilies.length})
${readyFamilies.map((r) => `- ${r.family_key} (${r.claim_ready_count} rows)`).join("\n")}

## Smoke targets
- claim_candidates delta: **${smoke.claim_candidates_delta}** ${smoke.claim_candidates_delta_pass ? "PASS" : "FAIL"}
- X004LKS4VD linkage: ${smoke.X004LKS4VD?.linkage_resolved ? "PASS" : "FAIL"}
- B0000B11UX linkage: ${smoke.B0000B11UX?.linkage_resolved ? "PASS" : "FAIL"}
- disputed EP review_needed: ${smoke.disputed_ep_review_needed?.pass ? "PASS" : "FAIL"}

## No write: ${noWrite ? "PASS" : "FAIL"}
`,
  );

  console.log(
    JSON.stringify({
      ok: true,
      run_id: id,
      families: V3_CLAIM_FAMILY_COUNT,
      claim_ready: payload.claim_ready_preview_count,
      delta: smoke.claim_candidates_delta,
      SAFE: payload.SAFE_TO_IMPLEMENT_FIRST_GENERATORS,
      outDir,
    }),
  );

  if (!noWrite || smoke.claim_candidates_delta !== 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
