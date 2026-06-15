/**
 * Smoke — grouping filters readmodel V1
 *   npx tsx scripts/smoke-claim-grouping-filters-manual-batch-readmodel-v1.ts --run-id=<UTC> [--staging]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  GROUPING_MODES_SUPPORTED,
  buildClaimGroupingReadmodel,
} from "../lib/claims/grouping/claim-grouping-readmodel";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/smoke-claim-grouping-filters-manual-batch-readmodel-v1";
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
    path.join(process.cwd(), "lib/claims/grouping/claim-grouping-readmodel.ts"),
    "utf8",
  );
  const noDbWrite =
    !/\b\.insert\s*\(/.test(src) &&
    !/\b\.update\s*\(/.test(src) &&
    !/\b\.upsert\s*\(/.test(src);

  let payload: Awaited<ReturnType<typeof buildClaimGroupingReadmodel>> | null = null;
  if (staging) {
    loadEnvLocalIntoProcess();
    const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
    const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
    if (refFromSupabaseUrl(url) === STAGING_REF) {
      const client = createClient(url, key, { auth: { persistSession: false } });
      payload = await buildClaimGroupingReadmodel({
        client,
        organizationId: ORG,
        storeId: STORE,
        filters: {
          organization_id: ORG,
          store_id: STORE,
          status: "claim_ready",
          grouping_mode: "product_family",
          limit: 10,
        },
      });
    }
  }

  const checks = {
    api_route_exists: fs.existsSync(
      path.join(process.cwd(), "app/api/claims/center/grouping-preview/route.ts"),
    ),
    handler_wired: fs.readFileSync(
      path.join(process.cwd(), "lib/claims/center/claim-center-api-handlers.ts"),
      "utf8",
    ).includes("getCenterGroupingPreviewPayload"),
    modes_count_8: GROUPING_MODES_SUPPORTED.length === 8,
    no_db_writes: noDbWrite,
    staging_when_requested: staging ? payload != null : true,
    groups_when_staging: staging ? (payload?.group_count ?? 0) > 0 : true,
    warnings_array: staging ? payload?.warning_rules_verification.pass === true : true,
    no_candidate_mutation: staging ? payload?.no_claim_candidate_mutation === true : true,
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-GROUPING-FILTERS-AND-MANUAL-BATCH-READMODEL-V1",
    run_id: id,
    checks,
    group_count: payload?.group_count ?? null,
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
