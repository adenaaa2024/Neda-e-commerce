/**
 * Smoke — grouping filters UI V1
 *   npx tsx scripts/smoke-claim-grouping-filters-ui-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { GROUPING_MODES_UI } from "../lib/claims/grouping/claim-grouping-ui-contract";

const OUT = ".cursor/audit-reports/smoke-claim-grouping-filters-ui-v1";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });
  const root = process.cwd();

  const view = fs.readFileSync(
    path.join(root, "components/claim-center/grouping/ClaimGroupBuilderView.tsx"),
    "utf8",
  );
  const filters = fs.readFileSync(
    path.join(root, "components/claim-center/grouping/ClaimGroupBuilderFilters.tsx"),
    "utf8",
  );
  const card = fs.readFileSync(
    path.join(root, "components/claim-center/grouping/ClaimGroupPreviewCard.tsx"),
    "utf8",
  );
  const manual = fs.readFileSync(
    path.join(root, "components/claim-center/grouping/ClaimGroupManualSelection.tsx"),
    "utf8",
  );
  const disabled = fs.readFileSync(
    path.join(root, "components/claim-center/grouping/ClaimGroupBuilderDisabledActions.tsx"),
    "utf8",
  );
  const page = fs.readFileSync(path.join(root, "app/claim-center/group-builder/page.tsx"), "utf8");
  const apiRoute = fs.readFileSync(
    path.join(root, "app/api/claims/center/grouping-preview/route.ts"),
    "utf8",
  );

  const checks = {
    page_wires_view: page.includes("ClaimGroupBuilderView"),
    api_grouping_preview: view.includes("/api/claims/center/grouping-preview"),
    api_route_exists: apiRoute.includes("getCenterGroupingPreviewPayload"),
    grouping_modes_8: GROUPING_MODES_UI.length === 8,
    filter_product: filters.includes("product_id"),
    filter_asin_fnsku_sku: filters.includes("asin") && filters.includes("fnsku") && filters.includes("sku"),
    filter_status: filters.includes("STATUS_FILTER_OPTIONS"),
    filter_money_thresholds:
      filters.includes("min_estimated_payout") && filters.includes("min_observed_reimbursement"),
    group_card_fields:
      card.includes("group_title") &&
      card.includes("observed_reimbursement_sum") &&
      card.includes("estimated_amazon_payout_sum") &&
      card.includes("warnings"),
    manual_selection: manual.includes("Preview manual group"),
    warning_codes: fs
      .readFileSync(path.join(root, "components/claim-center/grouping/ClaimGroupWarningList.tsx"), "utf8")
      .includes("mixed_claim_families"),
    disabled_actions:
      disabled.includes("disabled") &&
      disabled.includes('data-claim-center-write="disabled-placeholder-only"'),
    no_fetch_post: !view.includes("method: 'POST'") && !view.includes('method: "POST"'),
    empty_loading_error: view.includes("Loading group previews") && view.includes("Could not load"),
    no_scanner_import: !view.includes("operator-mobile"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-GROUPING-FILTERS-UI-V1",
    run_id: id,
    checks,
    pass: failures.length === 0,
    smoke_result: failures.length === 0 ? "PASS" : "FAIL",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));

  if (failures.length) {
    console.error("FAIL:", failures.join(", "));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, run_id: id, smoke: "PASS" }));
}

main();
