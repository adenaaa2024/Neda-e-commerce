/**
 * Smoke — PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-V1 (static checks)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAIM_CENTER_FILING_RECOVERY_NAV,
  CLAIM_CENTER_MOBILE_MORE_GROUPS,
  CLAIM_CENTER_MORE_WORKFLOW,
} from "../components/claim-center/claim-center-nav-config";
import {
  REIMBURSEMENT_TRACKING_UI_VERSION,
} from "../lib/claims/submission/claim-reimbursement-tracking-ui-contract";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");
const TRACKING_HREF = "/claim-center/reimbursement-tracking";

const FILES = {
  ui_contract: "lib/claims/submission/claim-reimbursement-tracking-ui-contract.ts",
  nav: "lib/claims/submission/claim-reimbursement-tracking-nav.ts",
  api_route: "app/api/claims/center/reimbursement-tracking/route.ts",
  page: "app/claim-center/reimbursement-tracking/page.tsx",
  view: "components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx",
  drawer: "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx",
  table: "components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx",
  financial_nav: "components/claim-center/financial/ClaimCenterFinancialNav.tsx",
  handlers: "lib/claims/center/claim-center-api-handlers.ts",
};

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

function main(): void {
  const navConfig = read("components/claim-center/claim-center-nav-config.ts");
  const moreMenuCount = CLAIM_CENTER_MOBILE_MORE_GROUPS.flatMap((g) => g.items).filter(
    (i) => i.href === TRACKING_HREF,
  ).length;
  const workflowHasTracking = CLAIM_CENTER_MORE_WORKFLOW.some((i) => i.href === TRACKING_HREF);
  const filingHasTracking = CLAIM_CENTER_FILING_RECOVERY_NAV.some((i) => i.href === TRACKING_HREF);

  const view = read(FILES.view);
  const drawer = read(FILES.drawer);
  const table = read(FILES.table);
  const handlers = read(FILES.handlers);
  const apiRoute = read(FILES.api_route);

  const checks = {
    ui_contract_exists: fs.existsSync(path.join(REPO, FILES.ui_contract)),
    page_route: fs.existsSync(path.join(REPO, FILES.page)),
    api_route: fs.existsSync(path.join(REPO, FILES.api_route)),
    financial_nav: view.includes("ClaimCenterFinancialNav"),
    nav_tabs: read(FILES.nav).includes("Reimbursement Tracking"),
    nav_discoverable_workflow: filingHasTracking && !workflowHasTracking,
    nav_single_more_menu_entry: moreMenuCount === 1,
    nav_not_in_workflow_group: !workflowHasTracking,
    nav_in_filing_recovery_group: filingHasTracking,
    nav_discoverable_home_tile: read("components/claim-center/ClaimCenterCommandHomeTiles.tsx").includes(
      TRACKING_HREF,
    ),
    nav_active_state_helper: navConfig.includes(
      'itemPath === "/claim-center/reimbursement-tracking"',
    ),
    ux_helper_copy: read("components/claim-center/reimbursement-tracking/ReimbursementTrackingHeader.tsx").includes(
      "Draft/manual filing tracking only",
    ),
    summary_cards: view.includes("ReimbursementTrackingSummaryCards"),
    workflow_strip: view.includes("ReimbursementTrackingWorkflowStrip"),
    filters: view.includes("ReimbursementTrackingFilters"),
    detail_drawer: view.includes("ReimbursementTrackingDetailDrawer"),
    disabled_actions:
      read(FILES.view).includes("ReimbursementTrackingDisabledActions") &&
      read("components/claim-center/reimbursement-tracking/ReimbursementTrackingDisabledActions.tsx").includes(
        "REIMBURSEMENT_TRACKING_READ_ONLY_TOOLTIP",
      ),
    money_unknown: table.includes("Unknown") && !table.includes('?? "$0"'),
    reference_graph_drawer: drawer.includes("Reference graph"),
    read_only_api: handlers.includes("getCenterReimbursementTrackingPayload"),
    no_db_write_ui:
      !view.includes(".insert(") &&
      !view.includes(".update(") &&
      !apiRoute.includes(".insert(") &&
      !apiRoute.includes(".update("),
    no_amazon_api: !view.includes("amazon-sp-api"),
    safe_flags: read(FILES.ui_contract).includes("read_only: true"),
    version: read(FILES.ui_contract).includes(REIMBURSEMENT_TRACKING_UI_VERSION),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  console.log(
    JSON.stringify({
      smoke: failures.length === 0 ? "pass" : "fail",
      version: REIMBURSEMENT_TRACKING_UI_VERSION,
      route: "/claim-center/reimbursement-tracking",
      failures,
      SAFE_REIMBURSEMENT_TRACKING_UI_READY: failures.length === 0 ? "yes" : "no",
      SAFE_REIMBURSEMENT_TRACKING_UI_VISIBLE_ON_MAIN: failures.length === 0 ? "yes" : "no",
    }),
  );
  if (failures.length > 0) process.exitCode = 1;
}

main();
