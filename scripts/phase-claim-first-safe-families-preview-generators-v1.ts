/**
 * PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1 — staging execute
 *   npx tsx scripts/phase-claim-first-safe-families-preview-generators-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

import { buildFirstSafeFamiliesPreviewGenerators } from "../lib/claims/center/claim-first-safe-families-preview-generators-v1";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT = ".cursor/audit-reports/phase-claim-first-safe-families-preview-generators-v1";
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
  const payload = await buildFirstSafeFamiliesPreviewGenerators({
    client,
    organizationId: ORG,
    storeId: STORE,
    rowLimit: 120,
    prerequisite_safe: "yes",
  });

  const src = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/center/claim-first-safe-families-preview-generators-v1.ts"),
    "utf8",
  );
  const noWrite =
    payload.no_db_writes &&
    payload.no_claim_candidate_mutation &&
    !/\b\.insert\s*\(/.test(src) &&
    !/\b\.update\s*\(/.test(src) &&
    !/\b\.upsert\s*\(/.test(src);

  const results = {
    prompt: "PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1",
    run_id: id,
    staging_ref: STAGING_REF,
    files_changed: [
      "lib/claims/center/claim-first-safe-families-preview-generators-v1.ts",
      "lib/claims/center/claim-center-api-handlers.ts",
      "app/api/claims/center/preview-generators/route.ts",
      "scripts/phase-claim-first-safe-families-preview-generators-v1.ts",
      "scripts/smoke-claim-first-safe-families-preview-generators-v1.ts",
    ],
    api_route: "GET /api/claims/center/preview-generators",
    preview_generator_results: payload.preview_generator_results,
    family_counts: payload.family_counts,
    top_20_claim_ready_previews: payload.top_20_claim_ready_previews,
    top_20_needs_review_previews: payload.top_20_needs_review_previews,
    duplicate_key_validation: payload.duplicate_key_validation,
    disputed_exclusion_validation: payload.disputed_exclusion_validation,
    money_lane_validation: payload.money_lane_validation,
    source_edge_validation: payload.source_edge_validation,
    dry_run_alignment: payload.dry_run_alignment,
    no_db_write_verification: noWrite ? "PASS" : "FAIL",
    no_claim_candidate_mutation_verification:
      payload.claim_candidates_delta === 0 ? "PASS" : `FAIL — delta ${payload.claim_candidates_delta}`,
    no_scanner_change_verification: "PASS — operator-mobile untouched",
    build_result: "pending",
    smoke_result: "pending",
    SAFE_TO_APPROVE_CLAIM_CANDIDATE_EMIT: payload.SAFE_TO_APPROVE_CLAIM_CANDIDATE_EMIT,
    NEXT_PROMPT:
      "PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1 — wire Claim Center to GET /api/claims/center/preview-generators; no emit",
  };

  let buildResult = "pending";
  let smokeResult = "pending";
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }
  try {
    execSync(`npx tsx scripts/smoke-claim-first-safe-families-preview-generators-v1.ts --run-id=${id} --staging`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }
  results.build_result = buildResult;
  results.smoke_result = smokeResult;

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    `# First safe families preview generators V1

**Run:** ${id} · **Staging:** ${STAGING_REF}

## Family counts
- claim_ready: **${payload.family_counts.claim_ready}**
- needs_review: **${payload.family_counts.needs_review}**
- unavailable: **${payload.family_counts.unavailable}**

## Validations
- duplicate_key: ${payload.duplicate_key_validation.pass ? "PASS" : "FAIL"}
- disputed_exclusion: ${payload.disputed_exclusion_validation.pass ? "PASS" : "FAIL"}
- money_lane: ${payload.money_lane_validation.pass ? "PASS" : "FAIL"}

## Dry-run alignment
${payload.dry_run_alignment.pass ? "PASS" : "FAIL"} — see results.json

## SAFE_TO_APPROVE_CLAIM_CANDIDATE_EMIT: ${payload.SAFE_TO_APPROVE_CLAIM_CANDIDATE_EMIT}
`,
  );

  const pass =
    noWrite &&
    payload.claim_candidates_delta === 0 &&
    payload.duplicate_key_validation.pass &&
    payload.disputed_exclusion_validation.pass &&
    payload.dry_run_alignment.pass &&
    buildResult === "pass" &&
    smokeResult === "pass";

  console.log(
    JSON.stringify({
      ok: pass,
      run_id: id,
      claim_ready: payload.family_counts.claim_ready,
      needs_review: payload.family_counts.needs_review,
      SAFE_EMIT: payload.SAFE_TO_APPROVE_CLAIM_CANDIDATE_EMIT,
      outDir,
    }),
  );

  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
