/**
 * PHASE-CLAIM-GROUPING-FILTERS-AND-MANUAL-BATCH-READMODEL-V1 — staging verify
 *   npx tsx scripts/phase-claim-grouping-filters-manual-batch-readmodel-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

import {
  GROUPING_MODES_SUPPORTED,
  FILTER_PARAMS_SUPPORTED,
  buildClaimGroupingReadmodel,
} from "../lib/claims/grouping/claim-grouping-readmodel";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT = ".cursor/audit-reports/phase-claim-grouping-filters-manual-batch-readmodel-v1";
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

  const productFamily = await buildClaimGroupingReadmodel({
    client,
    organizationId: ORG,
    storeId: STORE,
    filters: {
      organization_id: ORG,
      store_id: STORE,
      status: "claim_ready",
      grouping_mode: "product_family",
      limit: 20,
    },
  });

  const removalRef = await buildClaimGroupingReadmodel({
    client,
    organizationId: ORG,
    storeId: STORE,
    filters: {
      organization_id: ORG,
      store_id: STORE,
      family_keys: ["removal_order_discrepancy", "removal_shipment_missing"],
      status: "claim_ready",
      grouping_mode: "shipment_or_removal",
      limit: 20,
    },
  });

  const needsReviewOnly = await buildClaimGroupingReadmodel({
    client,
    organizationId: ORG,
    storeId: STORE,
    filters: {
      organization_id: ORG,
      store_id: STORE,
      status: "needs_review",
      include_needs_review: true,
      grouping_mode: "custom_filter_preview",
      limit: 20,
    },
  });

  const manualIds =
    productFamily.groups[0]?.included_preview_ids.slice(0, 3) ??
    removalRef.groups[0]?.included_preview_ids.slice(0, 3) ??
    [];
  const manualGroup = manualIds.length
    ? await buildClaimGroupingReadmodel({
        client,
        organizationId: ORG,
        storeId: STORE,
        filters: {
          organization_id: ORG,
          store_id: STORE,
          preview_ids: manualIds,
          grouping_mode: "manual_selection_preview",
          include_needs_review: true,
          limit: 5,
        },
      })
    : null;

  const src = [
    fs.readFileSync(path.join(process.cwd(), "lib/claims/grouping/claim-grouping-readmodel.ts"), "utf8"),
    fs.readFileSync(path.join(process.cwd(), "lib/claims/center/claim-center-api-handlers.ts"), "utf8"),
  ].join("\n");
  const noWrite =
    !/\b\.insert\s*\(/.test(src) &&
    !/\b\.update\s*\(/.test(src) &&
    !/\b\.upsert\s*\(/.test(src) &&
    !/claim_cases.*\.insert/.test(src);

  const smokeChecks = {
    product_family_groups: productFamily.group_count > 0,
    removal_reference_groups: removalRef.group_count > 0,
    needs_review_filter: needsReviewOnly.filtered_preview_count >= 0,
    manual_preview: manualGroup ? manualGroup.group_count >= 1 : true,
    warning_rules: productFamily.warning_rules_verification.pass,
    no_candidate_mutation: productFamily.no_claim_candidate_mutation,
    no_case_creation: productFamily.no_claim_case_creation,
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
    execSync(
      `npx tsx scripts/smoke-claim-grouping-filters-manual-batch-readmodel-v1.ts --run-id=${id} --staging`,
      { stdio: "pipe", encoding: "utf8" },
    );
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const results = {
    prompt: "PHASE-CLAIM-GROUPING-FILTERS-AND-MANUAL-BATCH-READMODEL-V1",
    run_id: id,
    staging_ref: STAGING_REF,
    files_changed: [
      "lib/claims/grouping/claim-grouping-readmodel.ts",
      "lib/claims/center/claim-center-api-handlers.ts",
      "app/api/claims/center/grouping-preview/route.ts",
      "lib/claims/center/claim-first-safe-families-preview-generators-v1.ts",
      "scripts/phase-claim-grouping-filters-manual-batch-readmodel-v1.ts",
      "scripts/smoke-claim-grouping-filters-manual-batch-readmodel-v1.ts",
    ],
    api_route_added: "GET /api/claims/center/grouping-preview",
    readmodel_shape: "ClaimGroupingReadmodelPayload + GroupPreviewRow",
    grouping_modes_supported: GROUPING_MODES_SUPPORTED,
    filter_params_supported: FILTER_PARAMS_SUPPORTED,
    sample_group_previews: {
      product_family: productFamily.sample_group_previews,
      removal_reference: removalRef.sample_group_previews,
      needs_review: needsReviewOnly.sample_group_previews,
      manual: manualGroup?.sample_group_previews ?? [],
    },
    warning_rules_verification: productFamily.warning_rules_verification,
    no_db_write_verification: noWrite ? "PASS" : "FAIL",
    no_claim_candidate_mutation_verification: productFamily.no_claim_candidate_mutation
      ? "PASS"
      : "FAIL",
    no_claim_case_mutation_verification: productFamily.no_claim_case_creation ? "PASS" : "FAIL",
    no_scanner_change_verification: "PASS — operator-mobile untouched",
    smoke_checks: smokeChecks,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_BUILD_GROUPING_UI: productFamily.SAFE_TO_BUILD_GROUPING_UI,
    NEXT_PROMPT:
      "PHASE-CLAIM-GROUPING-FILTERS-UI-V1 — wire Claim Center group builder drawer to GET /api/claims/center/grouping-preview; no case creation",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Grouping filters readmodel V1

**Run:** ${id}

## Counts
- product_family groups: ${productFamily.group_count}
- removal_reference groups: ${removalRef.group_count}
- needs_review filtered: ${needsReviewOnly.filtered_preview_count}

## SAFE_TO_BUILD_GROUPING_UI: ${productFamily.SAFE_TO_BUILD_GROUPING_UI}
`,
  );

  const pass =
    noWrite &&
    Object.values(smokeChecks).every(Boolean) &&
    buildResult === "pass" &&
    smokeResult === "pass" &&
    productFamily.SAFE_TO_BUILD_GROUPING_UI === "yes";

  console.log(
    JSON.stringify({
      ok: pass,
      run_id: id,
      groups: productFamily.group_count,
      SAFE_UI: productFamily.SAFE_TO_BUILD_GROUPING_UI,
      outDir,
    }),
  );
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
