/**
 * Smoke — first safe families preview generators V1
 *   npx tsx scripts/smoke-claim-first-safe-families-preview-generators-v1.ts --run-id=<UTC> [--staging]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  FIRST_SAFE_PREVIEW_GENERATOR_FAMILIES,
  buildFirstSafeFamiliesPreviewGenerators,
} from "../lib/claims/center/claim-first-safe-families-preview-generators-v1";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/smoke-claim-first-safe-families-preview-generators-v1";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
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
  const id = runId();
  const staging = process.argv.includes("--staging");
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const src = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/center/claim-first-safe-families-preview-generators-v1.ts"),
    "utf8",
  );
  const noDbWrite =
    !/\b\.insert\s*\(/.test(src) &&
    !/\b\.update\s*\(/.test(src) &&
    !/\b\.upsert\s*\(/.test(src) &&
    !/claim_candidates.*\.insert/.test(src);

  let payload: Awaited<ReturnType<typeof buildFirstSafeFamiliesPreviewGenerators>> | null = null;
  if (staging) {
    loadEnvLocalIntoProcess();
    const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
    const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
    if (refFromSupabaseUrl(url) === STAGING_REF) {
      const client = createClient(url, key, { auth: { persistSession: false } });
      payload = await buildFirstSafeFamiliesPreviewGenerators({
        client,
        organizationId: ORG,
        storeId: STORE,
        rowLimit: 80,
        prerequisite_safe: "yes",
      });
    }
  }

  const checks = {
    family_count_4: FIRST_SAFE_PREVIEW_GENERATOR_FAMILIES.length === 4,
    api_route_exists: fs.existsSync(
      path.join(process.cwd(), "app/api/claims/center/preview-generators/route.ts"),
    ),
    handler_wired: fs.readFileSync(
      path.join(process.cwd(), "lib/claims/center/claim-center-api-handlers.ts"),
      "utf8",
    ).includes("getCenterPreviewGeneratorsPayload"),
    no_db_writes: noDbWrite,
    staging_when_requested: staging ? payload != null : true,
    duplicate_keys_unique: staging ? payload?.duplicate_key_validation.pass === true : true,
    disputed_never_claim_ready: staging
      ? payload?.disputed_exclusion_validation.pass === true
      : true,
    preview_shape: staging
      ? (payload?.previews[0]?.preview_id?.startsWith("preview-gen:v1:") ?? false)
      : true,
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1",
    run_id: id,
    checks,
    family_counts: payload?.family_counts ?? null,
    pass: failures.length === 0,
    smoke_result: failures.length === 0 ? "PASS" : "FAIL",
    SAFE_TO_PUSH: failures.length === 0 ? "yes" : "no",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));

  if (failures.length) {
    console.error("FAIL:", failures.join(", "));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, run_id: id, smoke: "PASS" }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
