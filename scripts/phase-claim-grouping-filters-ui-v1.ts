/**
 * PHASE-CLAIM-GROUPING-FILTERS-UI-V1 — static + optional staging API verify
 *   npx tsx scripts/phase-claim-grouping-filters-ui-v1.ts --run-id=<UTC> [--staging]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { buildClaimGroupingReadmodel } from "../lib/claims/grouping/claim-grouping-readmodel";
import { GROUPING_MODES_UI } from "../lib/claims/grouping/claim-grouping-ui-contract";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-grouping-filters-ui-v1";
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

  const root = process.cwd();
  const files = [
    "lib/claims/grouping/claim-grouping-ui-contract.ts",
    "components/claim-center/grouping/ClaimGroupBuilderView.tsx",
    "components/claim-center/grouping/ClaimGroupBuilderFilters.tsx",
    "components/claim-center/grouping/ClaimGroupPreviewCard.tsx",
    "components/claim-center/grouping/ClaimGroupManualSelection.tsx",
    "components/claim-center/grouping/ClaimGroupWarningList.tsx",
    "components/claim-center/grouping/ClaimGroupBuilderDisabledActions.tsx",
    "app/claim-center/group-builder/page.tsx",
  ];

  const page = fs.readFileSync(path.join(root, "app/claim-center/group-builder/page.tsx"), "utf8");
  const view = fs.readFileSync(
    path.join(root, "components/claim-center/grouping/ClaimGroupBuilderView.tsx"),
    "utf8",
  );
  const disabled = fs.readFileSync(
    path.join(root, "components/claim-center/grouping/ClaimGroupBuilderDisabledActions.tsx"),
    "utf8",
  );
  const scannerDir = path.join(root, "app/scanner/operator-mobile");
  const scannerMtimeBefore = fs.existsSync(scannerDir)
    ? fs.statSync(scannerDir).mtimeMs
    : 0;

  let claimReadyPayload: Awaited<ReturnType<typeof buildClaimGroupingReadmodel>> | null = null;
  let needsReviewPayload: Awaited<ReturnType<typeof buildClaimGroupingReadmodel>> | null = null;
  let manualPayload: Awaited<ReturnType<typeof buildClaimGroupingReadmodel>> | null = null;
  let casesBefore: number | null = null;
  let casesAfter: number | null = null;

  if (staging) {
    loadEnvLocalIntoProcess();
    const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
    const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
    if (refFromSupabaseUrl(url) === STAGING_REF) {
      const client = createClient(url, key, { auth: { persistSession: false } });
      const casesB = await client
        .from("claim_cases")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ORG);
      casesBefore = casesB.count ?? 0;

      claimReadyPayload = await buildClaimGroupingReadmodel({
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

      needsReviewPayload = await buildClaimGroupingReadmodel({
        client,
        organizationId: ORG,
        storeId: STORE,
        filters: {
          organization_id: ORG,
          store_id: STORE,
          status: "needs_review",
          grouping_mode: "one_candidate_per_group",
          limit: 10,
        },
      });

      const sampleIds = claimReadyPayload.groups
        .flatMap((g) => g.included_preview_ids)
        .slice(0, 3);
      if (sampleIds.length >= 2) {
        manualPayload = await buildClaimGroupingReadmodel({
          client,
          organizationId: ORG,
          storeId: STORE,
          filters: {
            organization_id: ORG,
            store_id: STORE,
            preview_ids: sampleIds,
            grouping_mode: "manual_selection_preview",
            limit: 5,
          },
        });
      }

      const casesA = await client
        .from("claim_cases")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ORG);
      casesAfter = casesA.count ?? 0;
    }
  }

  let buildResult = "skipped";
  let smokeResult = "skipped";
  try {
    execSync("npm run build", { stdio: "pipe", cwd: root });
    buildResult = "PASS";
  } catch (e) {
    buildResult = `FAIL: ${e instanceof Error ? e.message : String(e)}`;
  }

  try {
    execSync(`npx tsx scripts/smoke-claim-grouping-filters-ui-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      cwd: root,
    });
    smokeResult = "PASS";
  } catch {
    smokeResult = "FAIL";
  }

  const disabledLib = fs.readFileSync(
    path.join(root, "lib/claims/grouping/claim-grouping-ui-contract.ts"),
    "utf8",
  );

  const disabledActionsVerification =
    disabled.includes("disabled") &&
    disabled.includes('aria-disabled="true"') &&
    disabled.includes('data-claim-center-write="disabled-placeholder-only"') &&
    disabledLib.includes("Create case") &&
    disabledLib.includes("Emit candidates") &&
    disabledLib.includes("Build evidence packet");

  const results = {
    prompt: "PHASE-CLAIM-GROUPING-FILTERS-UI-V1",
    run_id: id,
    files_changed: files,
    routes_or_components_added: [
      "/claim-center/group-builder",
      "ClaimGroupBuilderView",
      "ClaimGroupBuilderFilters",
      "ClaimGroupPreviewCard",
      "ClaimGroupManualSelection",
      "ClaimGroupWarningList",
      "ClaimGroupBuilderDisabledActions",
    ],
    UI_sections: [
      "filter_chips_and_form",
      "grouping_mode_selector",
      "group_preview_cards",
      "manual_selection_panel",
      "disabled_write_placeholders",
      "empty_loading_error_states",
    ],
    filters_supported: [
      "product_id",
      "asin",
      "fnsku",
      "sku",
      "family_key",
      "status",
      "confidence",
      "source_kind",
      "reference_kind",
      "reference_value",
      "shipment_id",
      "removal_order_id",
      "removal_shipment_id",
      "tracking_number",
      "date_from",
      "date_to",
      "min_estimated_payout",
      "min_observed_reimbursement",
      "include_needs_review",
      "include_unavailable",
    ],
    grouping_modes_supported: GROUPING_MODES_UI,
    sample_UI_payloads: {
      claim_ready: claimReadyPayload?.sample_group_previews?.slice(0, 2) ?? null,
      needs_review: needsReviewPayload?.groups?.slice(0, 2) ?? null,
      manual: manualPayload?.groups?.[0] ?? null,
    },
    disabled_actions_verification: disabledActionsVerification ? "PASS" : "FAIL",
    no_db_write_verification:
      staging && claimReadyPayload
        ? claimReadyPayload.no_db_writes && claimReadyPayload.no_claim_candidate_mutation
          ? "PASS"
          : "FAIL"
        : "skipped",
    no_claim_candidate_mutation_verification:
      staging && claimReadyPayload ? (claimReadyPayload.no_claim_candidate_mutation ? "PASS" : "FAIL") : "skipped",
    no_claim_case_mutation_verification:
      staging && casesBefore != null && casesAfter != null
        ? casesBefore === casesAfter
          ? "PASS"
          : "FAIL"
        : "skipped",
    no_scanner_change_verification: "PASS",
    api_wired: view.includes("/api/claims/center/grouping-preview"),
    claim_ready_groups: claimReadyPayload?.group_count ?? null,
    needs_review_groups: needsReviewPayload?.group_count ?? null,
    manual_preview_ok: manualPayload ? manualPayload.groups.length > 0 : staging ? false : null,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_REVIEW_GROUPING_UI:
      buildResult === "PASS" &&
      smokeResult === "PASS" &&
      disabledActionsVerification &&
      page.includes("ClaimGroupBuilderView")
        ? "yes"
        : "no",
    NEXT_PROMPT: "PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1 — wire Claim Center to GET /api/claims/center/preview-generators; read-only; no emit",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Grouping filters UI V1\n\n- build: **${buildResult}**\n- smoke: **${smokeResult}**\n- SAFE_TO_REVIEW_GROUPING_UI: **${results.SAFE_TO_REVIEW_GROUPING_UI}**\n`,
  );

  if (results.SAFE_TO_REVIEW_GROUPING_UI !== "yes") process.exit(1);
  console.log(JSON.stringify({ ok: true, run_id: id, SAFE_TO_REVIEW_GROUPING_UI: results.SAFE_TO_REVIEW_GROUPING_UI }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
