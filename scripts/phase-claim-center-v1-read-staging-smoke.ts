/**
 * Claim Center staging smoke — zero writes (UX fix pack + shell V1).
 *   npx tsx scripts/phase-claim-center-v1-read-staging-smoke.ts
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-claim-center-v1-read-staging-smoke";
const ORG = "7397edff-7994-4731-8501-55d258d507d2";

const CLAIM_CENTER_ROUTES = [
  "app/claim-center/page.tsx",
  "app/claim-center/opportunities/page.tsx",
  "app/claim-center/candidates/page.tsx",
  "app/claim-center/review/page.tsx",
  "app/claim-center/evidence/page.tsx",
  "app/claim-center/references/page.tsx",
  "app/claim-center/product-linkage/page.tsx",
  "app/claim-center/cases/page.tsx",
  "app/claim-center/submissions/page.tsx",
  "app/claim-center/recovery/page.tsx",
  "app/claim-center/runs/page.tsx",
  "app/claim-center/sources/page.tsx",
  "app/claim-center/settings/page.tsx",
  "app/claim-center/policies/page.tsx",
  "app/claim-center/group-builder/page.tsx",
];

const SHELL_V1_COMPONENTS = [
  "components/claim-center/ClaimCenterAppShell.tsx",
  "components/claim-center/ClaimCenterWorkflowBar.tsx",
  "components/claim-center/ClaimCenterFlowPositionHeader.tsx",
  "components/claim-center/ClaimCenterFlowCountsProvider.tsx",
  "components/claim-center/ClaimCenterLifecycleFlowStrip.tsx",
  "components/claim-center/ClaimCenterMobileNav.tsx",
  "components/claim-center/ClaimCenterPolicySnapshotPanel.tsx",
  "components/claim-center/ClaimCenterLegacyToolsMenu.tsx",
  "components/claim-center/ClaimCenterDetailStoryBlocks.tsx",
  "components/claim-center/ClaimCenterV2PageShell.tsx",
  "components/claim-center/ClaimCenterDataReadinessBanner.tsx",
  "components/claim-center/ClaimCenterSourcesView.tsx",
  "lib/claims/center/claim-center-flow-nav.ts",
  "lib/claims/center/claim-center-filter-presets.ts",
  "lib/claims/center/claim-center-policy-ownership.ts",
  "lib/claims/center/claim-center-detail-story.ts",
  "lib/claims/center/claim-center-v2-page-contract.ts",
];

const UX_FIX_COMPONENTS = [
  "lib/claims/center/claim-center-ui-copy.ts",
  "components/claim-center/ClaimCenterSectionEmptyState.tsx",
  "components/claim-center/ClaimCenterSampleWarningBanner.tsx",
  "components/claim-center/ClaimCenterBridgePhaseNotice.tsx",
  "components/claim-center/ClaimCenterHiddenRowsNotice.tsx",
];

const MENORIX_V2_COMPONENTS = [
  "components/menorix/MenorixModuleAppShell.tsx",
  "components/menorix/MenorixModuleCommandHome.tsx",
  "components/menorix/MenorixModuleTileGrid.tsx",
  "components/menorix/MenorixModuleKpiStrip.tsx",
  "components/menorix/MenorixModuleScopeBar.tsx",
  "components/menorix/MenorixModuleSectionTabs.tsx",
  "components/menorix/MenorixModuleDetailDrawer.tsx",
  "components/menorix/MenorixModuleMobileDetailSheet.tsx",
  "components/menorix/MenorixModuleEmptyState.tsx",
  "components/menorix/MenorixModuleFeatureLockedCard.tsx",
  "components/menorix/MenorixModuleAiAssistCard.tsx",
  "components/menorix/MenorixModuleAutomationHealthCard.tsx",
  "components/menorix/MenorixModuleViewSwitcher.tsx",
  "components/menorix/MenorixModuleQuickActions.tsx",
  "components/menorix/MenorixModuleMobileFilterSheet.tsx",
];

const SCANNER_PATH_PREFIXES = ["app/scanner/operator-mobile/", "components/scanner/"];

const FORBIDDEN_SCANNER_IMPORTS = ["MenorixModule", "claim-center", "components/menorix"];

const WRITE_ACTION_PATTERNS = [
  /Promote candidate/i,
  /Submit claim/i,
  /Create case/i,
  /Generate PDF/i,
  /onPromote/i,
  /onSubmit/i,
];

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(ent.name)) acc.push(p);
  }
  return acc;
}

function scannerFilesUntouched(root: string): { ok: boolean; scanned: number; violations: string[] } {
  const violations: string[] = [];
  let scanned = 0;
  for (const prefix of SCANNER_PATH_PREFIXES) {
    const abs = path.join(root, prefix);
    for (const file of walkFiles(abs)) {
      scanned += 1;
      const rel = path.relative(root, file).replace(/\\/g, "/");
      const text = fs.readFileSync(file, "utf8");
      for (const token of FORBIDDEN_SCANNER_IMPORTS) {
        if (text.includes(token)) violations.push(`${rel} contains ${token}`);
      }
    }
  }
  return { ok: violations.length === 0, scanned, violations };
}

function detailStoryChecks(root: string): {
  ok: boolean;
  six_blocks_present: boolean;
  sticky_header_present: boolean;
  wide_desktop_drawer: boolean;
  no_write_buttons: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const blocks = read(root, "components/claim-center/ClaimCenterDetailStoryBlocks.tsx");
  const drawer = read(root, "components/claim-center/ClaimCenterDetailDrawer.tsx");
  const storyLib = read(root, "lib/claims/center/claim-center-detail-story.ts");

  const sixBlocks =
    blocks.includes('title="Event"') &&
    blocks.includes('title="Product"') &&
    blocks.includes('title="Evidence"') &&
    blocks.includes('title="Reference / TRID"') &&
    blocks.includes('title="Rules used"') &&
    blocks.includes('title="Next step"') &&
    storyLib.includes("CLAIM_CENTER_DETAIL_BLOCK_ORDER");

  const stickyHeader = blocks.includes("ClaimCenterDetailStickyHeader");
  const wideDrawer = drawer.includes("max-w-3xl") && drawer.includes("xl:max-w-5xl");
  const writePatterns = [/Promote/i, /Submit claim/i, /Create case/i, /Generate PDF/i, /onPromote/i];
  const noWrite = !writePatterns.some((p) => p.test(drawer + blocks));

  if (!sixBlocks) violations.push("Six-block detail story incomplete");
  if (!stickyHeader) violations.push("Sticky detail header missing");
  if (!wideDrawer) violations.push("Wide desktop detail drawer missing");
  if (!noWrite) violations.push("Write action patterns in detail story");

  return {
    ok: violations.length === 0,
    six_blocks_present: sixBlocks,
    sticky_header_present: stickyHeader,
    wide_desktop_drawer: wideDrawer,
    no_write_buttons: noWrite,
    violations,
  };
}

function policyReadModelChecks(root: string): {
  ok: boolean;
  policy_contract_module: boolean;
  derive_lifecycle: boolean;
  expiration_warning_policy: boolean;
  sources_route: boolean;
  policy_context_handlers: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const contract = read(root, "lib/claims/intake/claim-intake-policy-contract.ts");
  const window = read(root, "lib/claims/center/claim-center-v1-window.ts");
  const readModel = read(root, "lib/claims/center/claim-center-v1-read-model.ts");
  const handlers = read(root, "lib/claims/center/claim-center-api-handlers.ts");
  const sourcesRoute = fs.existsSync(path.join(root, "app/api/claims/center/sources/route.ts"));

  const policyModule =
    contract.includes("deriveClaimLifecycleStatus") &&
    contract.includes("loadEffectiveClaimIntakePolicy") &&
    contract.includes("expiration_warning_days");
  const deriveLifecycle =
    contract.includes("mapLifecycleToV1StatusGroup") && readModel.includes("deriveClaimLifecycleStatus");
  const expirationPolicy =
    window.includes("expirationWarningDays") && !window.includes("if (days <= 14)");
  const policyHandlers =
    handlers.includes("policy_context") &&
    handlers.includes("getCenterSourcesPayload") &&
    handlers.includes("loadEffectiveClaimIntakePolicy");

  if (!policyModule) violations.push("Policy contract module incomplete");
  if (!deriveLifecycle) violations.push("Lifecycle derivation not wired");
  if (!expirationPolicy) violations.push("Hardcoded 14-day window still present");
  if (!sourcesRoute) violations.push("Sources API route missing");
  if (!policyHandlers) violations.push("Policy context not on API handlers");

  return {
    ok: violations.length === 0,
    policy_contract_module: policyModule,
    derive_lifecycle: deriveLifecycle,
    expiration_warning_policy: expirationPolicy,
    sources_route: sourcesRoute,
    policy_context_handlers: policyHandlers,
    violations,
  };
}

function physicalReturnMvpChecks(root: string): {
  ok: boolean;
  physical_return_mvp_module: boolean;
  mvp_filter_wired: boolean;
  operational_copy: boolean;
  detail_physical_story: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const mvp = read(root, "lib/claims/center/claim-center-physical-return-mvp.ts");
  const readModel = read(root, "lib/claims/center/claim-center-v1-read-model.ts");
  const handlers = read(root, "lib/claims/center/claim-center-api-handlers.ts");
  const money = read(root, "lib/claims/center/claim-center-candidate-money.ts");
  const detailBlocks = read(root, "components/claim-center/ClaimCenterDetailStoryBlocks.tsx");
  const detailStory = read(root, "lib/claims/center/claim-center-detail-story.ts");
  const uiCopy = read(root, "lib/claims/center/claim-center-ui-copy.ts");

  const moduleOk =
    mvp.includes("isPhysicalReturnMvpRow") &&
    mvp.includes("filterPhysicalReturnMvpRows") &&
    mvp.includes("attachPhysicalReturnMvpFields") &&
    mvp.includes("Physical return issue") &&
    mvp.includes("Off-manifest item") &&
    mvp.includes("References not materialized yet");

  const filterWired =
    readModel.includes("attachPhysicalReturnMvpFields") &&
    handlers.includes("filterPhysicalReturnMvpRows") &&
    handlers.includes("physicalReturnMvpOnly");

  const operationalCopy =
    money.includes("Cost unknown") &&
    money.includes("Unpriced — add cost to see recovery") &&
    uiCopy.includes("Proof missing") &&
    uiCopy.includes("No observed reimbursements linked yet");

  const detailPhysicalStory =
    detailBlocks.includes("claimCenterPhysicalEventLabel") &&
    detailBlocks.includes("claimCenterMoneyStatusSummary") &&
    detailBlocks.includes("claimCenterReferenceStatusSummary") &&
    detailBlocks.includes("What is missing next") &&
    detailBlocks.includes("Product not matched") &&
    detailStory.includes("claimCenterMissingNextSummary");

  if (!moduleOk) violations.push("Physical return MVP module incomplete");
  if (!filterWired) violations.push("Physical return MVP filter not wired");
  if (!operationalCopy) violations.push("Operational copy strings missing");
  if (!detailPhysicalStory) violations.push("Detail physical story blocks incomplete");

  return {
    ok: violations.length === 0,
    physical_return_mvp_module: moduleOk,
    mvp_filter_wired: filterWired,
    operational_copy: operationalCopy,
    detail_physical_story: detailPhysicalStory,
    violations,
  };
}

function queueSemanticsChecks(root: string): {
  ok: boolean;
  queue_semantics_module: boolean;
  money_projection_module: boolean;
  twin_grouping_ui: boolean;
  opportunities_includes_blocked: boolean;
  recovery_observed_only: boolean;
  evidence_route: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const queue = read(root, "lib/claims/center/claim-center-queue-semantics.ts");
  const moneyProj = read(root, "lib/claims/center/claim-center-candidate-money.ts");
  const handlers = read(root, "lib/claims/center/claim-center-api-handlers.ts");
  const twins = read(root, "components/claim-center/ClaimCenterTwinSourceChips.tsx");
  const oppView = read(root, "components/claim-center/ClaimCenterOpportunitiesView.tsx");
  const evidenceRoute = fs.existsSync(path.join(root, "app/api/claims/center/evidence/route.ts"));

  const queueModule = queue.includes("filterFindMoneyRows") && queue.includes("filterObservedRecoveryRows");
  const moneyModule =
    moneyProj.includes("amount_display_label") &&
    moneyProj.includes("Cost unknown") &&
    moneyProj.includes("zero_unpriced");
  const twinUi = twins.includes("twinSourceChipLabel") && oppView.includes("ClaimCenterOpportunitiesView");
  const oppBlocked = handlers.includes("filterFindMoneyRows") && handlers.includes("blocked_money_items");
  const recoveryOnly = handlers.includes("filterObservedRecoveryRows") && handlers.includes("No observed reimbursements");

  if (!queueModule) violations.push("Queue semantics module missing");
  if (!moneyModule) violations.push("Candidate money projection missing");
  if (!twinUi) violations.push("Twin grouping UI missing");
  if (!oppBlocked) violations.push("Opportunities does not include blocked recoverable");
  if (!recoveryOnly) violations.push("Recovery not observed-only");
  if (!evidenceRoute) violations.push("Evidence API route missing");

  return {
    ok: violations.length === 0,
    queue_semantics_module: queueModule,
    money_projection_module: moneyModule,
    twin_grouping_ui: twinUi,
    opportunities_includes_blocked: oppBlocked,
    recovery_observed_only: recoveryOnly,
    evidence_route: evidenceRoute,
    violations,
  };
}

function commandHomeV2Checks(root: string): {
  ok: boolean;
  command_board: boolean;
  command_home_tiles: boolean;
  attention_list: boolean;
  money_contract_module: boolean;
  no_fake_amount_sum: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const dashboard = read(root, "components/claim-center/ClaimCenterCommandDashboard.tsx");
  const board = read(root, "components/claim-center/ClaimCenterCommandBoard.tsx");
  const tiles = read(root, "components/claim-center/ClaimCenterCommandHomeTiles.tsx");
  const attention = read(root, "components/claim-center/ClaimCenterAttentionList.tsx");
  const money = read(root, "lib/claims/center/claim-center-money-contract.ts");
  const readModel = read(root, "lib/claims/center/claim-center-v1-read-model.ts");

  const commandBoard =
    board.includes('data-claim-center="command-board"') && board.includes("CLAIM_CENTER_COMMAND_BOARD_META");
  const commandTiles =
    tiles.includes('data-claim-center="command-home-tiles"') &&
    tiles.includes("Cost unknown") &&
    tiles.includes("Not linked yet") &&
    tiles.includes("find_money_count");
  const attentionList =
    attention.includes('data-claim-center="attention-list"') && attention.includes("humanCandidateLabel");
  const moneyModule = money.includes("aggregateClaimCenterMoney") && money.includes("buildAttentionList");
  const noFakeSum =
    !readModel.includes("recoverable += r.recovery_value ?? 0") &&
    readModel.includes("aggregateClaimCenterMoney");

  if (!commandBoard) violations.push("Command board missing");
  if (!commandTiles) violations.push("Command home tiles missing");
  if (!attentionList) violations.push("Attention list missing");
  if (!moneyModule) violations.push("Money contract module missing");
  if (!noFakeSum) violations.push("Dashboard still sums unknown as zero");
  if (!dashboard.includes("ClaimCenterCommandBoard")) violations.push("Dashboard missing command board wire");

  return {
    ok: violations.length === 0,
    command_board: commandBoard,
    command_home_tiles: commandTiles,
    attention_list: attentionList,
    money_contract_module: moneyModule,
    no_fake_amount_sum: noFakeSum,
    violations,
  };
}

function mobilePolishChecks(root: string): {
  ok: boolean;
  mobile_lifecycle_header: boolean;
  more_sheet_purpose: boolean;
  mobile_cards_rich: boolean;
  mobile_detail_summary: boolean;
  empty_state_safe_action: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const lifecycle = read(root, "components/claim-center/ClaimCenterMobileLifecycleHeader.tsx");
  const appShell = read(root, "components/claim-center/ClaimCenterAppShell.tsx");
  const mobileNav = read(root, "components/claim-center/ClaimCenterMobileNav.tsx");
  const mobileCards = read(root, "components/claim-center/ClaimCenterMobileCards.tsx");
  const detailDrawer = read(root, "components/claim-center/ClaimCenterDetailDrawer.tsx");
  const emptyState = read(root, "components/claim-center/ClaimCenterSectionEmptyState.tsx");
  const navMeta = read(root, "lib/claims/center/claim-center-mobile-nav-meta.ts");

  const mobileLifecycleHeader =
    lifecycle.includes("data-claim-center=\"mobile-lifecycle-header\"") &&
    lifecycle.includes("snap-x") &&
    appShell.includes("ClaimCenterMobileLifecycleHeader");
  const moreSheetPurpose =
    mobileNav.includes("data-claim-center=\"mobile-more-sheet\"") &&
    mobileNav.includes("meta.purpose") &&
    navMeta.includes("getClaimCenterMoreNavMeta");
  const mobileCardsRich =
    mobileCards.includes("claim-center-mobile-card--rich") &&
    mobileCards.includes("exposure") &&
    mobileCards.includes("Tap for full story");
  const mobileDetailSummary =
    detailDrawer.includes("ClaimCenterMobileDetailSummary") &&
    detailDrawer.includes("data-claim-center=\"mobile-detail-sheet\"");
  const emptyStateSafeAction =
    emptyState.includes("safeActionHref") && emptyState.includes("Pool empty") && emptyState.includes("Queue clear");

  if (!mobileLifecycleHeader) violations.push("Mobile lifecycle header missing");
  if (!moreSheetPurpose) violations.push("More sheet purpose lines missing");
  if (!mobileCardsRich) violations.push("Rich mobile cards missing");
  if (!mobileDetailSummary) violations.push("Mobile detail summary missing");
  if (!emptyStateSafeAction) violations.push("Mobile empty state safe action missing");

  return {
    ok: violations.length === 0,
    mobile_lifecycle_header: mobileLifecycleHeader,
    more_sheet_purpose: moreSheetPurpose,
    mobile_cards_rich: mobileCardsRich,
    mobile_detail_summary: mobileDetailSummary,
    empty_state_safe_action: emptyStateSafeAction,
    violations,
  };
}

function flowNavChecks(root: string): {
  ok: boolean;
  workflow_bar_present: boolean;
  desktop_rail_removed: boolean;
  hide_rail_shell: boolean;
  you_are_here_header: boolean;
  workflow_steps_seven: boolean;
  menu_in_menu_removed: boolean;
  lifecycle_flow_strip: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const appShell = read(root, "components/claim-center/ClaimCenterAppShell.tsx");
  const workflowBar = read(root, "components/claim-center/ClaimCenterWorkflowBar.tsx");
  const positionHeader = read(root, "components/claim-center/ClaimCenterFlowPositionHeader.tsx");
  const flowNav = read(root, "lib/claims/center/claim-center-flow-nav.ts");
  const menorixShell = read(root, "components/menorix/MenorixModuleAppShell.tsx");
  const dashboard = read(root, "components/claim-center/ClaimCenterCommandDashboard.tsx");

  const workflowBarPresent =
    appShell.includes("ClaimCenterWorkflowBar") &&
    workflowBar.includes("data-claim-center=\"workflow-bar\"") &&
    workflowBar.includes("claim-center-workflow-bar");
  const desktopRailRemoved = !appShell.includes("ClaimCenterDesktopRail");
  const hideRailShell = appShell.includes("hideRail") && menorixShell.includes("hideRail");
  const youAreHere =
    positionHeader.includes("You are here") &&
    positionHeader.includes("Step") &&
    positionHeader.includes("Data source");
  const stepsSeven =
    flowNav.includes("find_money") &&
    flowNav.includes("sources") &&
    (flowNav.match(/order: \d/g) ?? []).length >= 7;
  const menuInMenu = desktopRailRemoved && hideRailShell;
  const lifecycleStrip =
    dashboard.includes("ClaimCenterCommandBoard") || dashboard.includes("ClaimCenterLifecycleFlowStrip");

  if (!workflowBarPresent) violations.push("Workflow command bar missing");
  if (!desktopRailRemoved) violations.push("Desktop rail still wired in app shell");
  if (!hideRailShell) violations.push("hideRail not enabled on module shell");
  if (!youAreHere) violations.push("You-are-here flow header incomplete");
  if (!stepsSeven) violations.push("Flow nav not 7 steps");
  if (!lifecycleStrip) violations.push("Home lifecycle flow strip missing");

  return {
    ok: violations.length === 0,
    workflow_bar_present: workflowBarPresent,
    desktop_rail_removed: desktopRailRemoved,
    hide_rail_shell: hideRailShell,
    you_are_here_header: youAreHere,
    workflow_steps_seven: stepsSeven,
    menu_in_menu_removed: menuInMenu,
    lifecycle_flow_strip: lifecycleStrip,
    violations,
  };
}

function legacyBoundaryChecks(root: string): {
  ok: boolean;
  workflow_nav_eight: boolean;
  mobile_bottom_three: boolean;
  legacy_tools_menu: boolean;
  no_external_rail: boolean;
  dashboard_four_tiles: boolean;
  no_legacy_in_detail_cta: boolean;
  no_group_builder_in_legacy_tools: boolean;
  sources_human_cards: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const navConfig = read(root, "components/claim-center/claim-center-nav-config.ts");
  const dashboard = read(root, "components/claim-center/ClaimCenterCommandDashboard.tsx");
  const rootClient = read(root, "components/claim-center/ClaimCenterRootClient.tsx");
  const detailBlocks = read(root, "components/claim-center/ClaimCenterDetailStoryBlocks.tsx");
  const sourcesView = read(root, "components/claim-center/ClaimCenterSourcesView.tsx");
  const runsPage = read(root, "app/claim-center/runs/page.tsx");

  const flowNav = read(root, "lib/claims/center/claim-center-flow-nav.ts");
  const workflowEight =
    (flowNav.match(/order: \d/g) ?? []).length >= 7 &&
    flowNav.includes("find_money") &&
    flowNav.includes("/claim-center/sources") &&
    !flowNav.includes("group-builder");

  const mobileBlock = navConfig.match(/CLAIM_CENTER_MOBILE_BOTTOM[\s\S]*?\];/)?.[0] ?? "";
  const mobileBottomThree =
    mobileBlock.split("href:").length - 1 === 3 &&
    mobileBlock.includes("/claim-center/evidence") &&
    mobileBlock.includes("Proof");

  const legacyMenu =
    fs.existsSync(path.join(root, "components/claim-center/ClaimCenterLegacyToolsMenu.tsx")) &&
    rootClient.includes("ClaimCenterLegacyToolsMenu") &&
    navConfig.includes("CLAIM_CENTER_LEGACY_TOOLS");

  const railSection = navConfig.match(/export const CLAIM_CENTER_RAIL_GROUPS[\s\S]*?\];/)?.[0] ?? "";
  const noExternalRail =
    !navConfig.includes('id: "external"') && !railSection.includes("/claim-engine") && railSection.includes("[]");

  const homeTiles = read(root, "components/claim-center/ClaimCenterCommandHomeTiles.tsx");
  const fourTiles =
    dashboard.includes("ClaimCenterCommandBoard") &&
    dashboard.includes("ClaimCenterCommandHomeTiles") &&
    dashboard.includes("ClaimCenterAttentionList") &&
    homeTiles.includes("Potential recovery") &&
    homeTiles.includes("Cost unknown") &&
    homeTiles.includes("Not linked yet") &&
    !dashboard.includes('id: "policy_snapshot"') &&
    dashboard.includes("ClaimCenterDataReadinessBanner");

  const noLegacyDetailCta =
    !detailBlocks.includes("href={step.legacyHref}") && detailBlocks.includes("Legacy tools");

  const legacyToolsBlock = navConfig.match(/CLAIM_CENTER_LEGACY_TOOLS[\s\S]*?\];/)?.[0] ?? "";
  const noGroupBuilderInLegacy = !legacyToolsBlock.includes("group-builder");

  const sourcesHuman =
    sourcesView.includes("humanSourceLabel") &&
    sourcesView.includes("data-source-card") &&
    !sourcesView.includes("JSON.stringify") &&
    runsPage.includes('redirect("/claim-center/sources")');

  if (!workflowEight) violations.push("Workflow rail not 8 pages");
  if (!mobileBottomThree) violations.push("Mobile bottom not Home/Money/Review");
  if (!legacyMenu) violations.push("Legacy tools menu missing");
  if (!noExternalRail) violations.push("External legacy still in rail");
  if (!fourTiles) violations.push("Dashboard not V2 (4 tiles + readiness banner)");
  if (!noLegacyDetailCta) violations.push("Legacy link still primary in detail next-step");
  if (!noGroupBuilderInLegacy) violations.push("Group builder still in legacy tools");
  if (!sourcesHuman) violations.push("Sources page not human-readable");

  return {
    ok: violations.length === 0,
    workflow_nav_eight: workflowEight,
    mobile_bottom_three: mobileBottomThree,
    legacy_tools_menu: legacyMenu,
    no_external_rail: noExternalRail,
    dashboard_four_tiles: fourTiles,
    no_legacy_in_detail_cta: noLegacyDetailCta,
    no_group_builder_in_legacy_tools: noGroupBuilderInLegacy,
    sources_human_cards: sourcesHuman,
    violations,
  };
}

function policyOwnershipChecks(root: string): {
  ok: boolean;
  policy_snapshot_label: boolean;
  no_settings_in_ops_nav: boolean;
  ownership_intro_present: boolean;
  owner_links_present: boolean;
  no_writable_controls: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const navConfig = read(root, "components/claim-center/claim-center-nav-config.ts");
  const hubNav = read(root, "components/claim-center/ClaimCenterHubNav.tsx");
  const policiesPage = read(root, "app/claim-center/policies/page.tsx");
  const ownershipLib = read(root, "lib/claims/center/claim-center-policy-ownership.ts");
  const snapshotPanel = read(root, "components/claim-center/ClaimCenterPolicySnapshotPanel.tsx");

  const pageContract = read(root, "lib/claims/center/claim-center-v2-page-contract.ts");
  const policySnapshotLabel =
    (policiesPage.includes("Policy snapshot") || pageContract.includes('navLabel: "Policy snapshot"')) &&
    ownershipLib.includes("POLICY_SNAPSHOT_INTRO");

  const workflowBlock = navConfig.match(/CLAIM_CENTER_WORKFLOW_NAV[\s\S]*?\];/)?.[0] ?? "";
  const noSettingsInOpsNav =
    !hubNav.includes('"Settings"') &&
    !hubNav.includes("/claim-center/settings") &&
    !workflowBlock.includes("/claim-center/policies") &&
    !workflowBlock.includes("Policy snapshot") &&
    !navConfig.includes('id: "external"') &&
    !navConfig.includes('id: "utility"') &&
    (navConfig.includes('id: "admin_legacy"') || navConfig.includes('id: "admin"'));

  const ownerLinks =
    ownershipLib.includes("CLAIMS_SETTINGS_HREF") &&
    ownershipLib.includes("/platform/settings/automation") &&
    ownershipLib.includes("/platform/access") &&
    ownershipLib.includes("/platform/users");

  const writablePatterns = [
    /type=["']checkbox["']/i,
    /type=["']switch["']/i,
    /ClaimCandidateIntakePolicyPanel/i,
    /<Switch/i,
    /onSave/i,
    /saveOrganization/i,
    /type=["']submit["']/i,
  ];
  const policiesBundle = policiesPage + snapshotPanel;
  const noWritable = !writablePatterns.some((p) => p.test(policiesBundle));

  if (!noSettingsInOpsNav) violations.push("Policy snapshot or settings still in primary nav");
  if (!ownerLinks) violations.push("Owner route links missing in ownership config");
  if (!noWritable) violations.push("Writable controls detected on policy snapshot page");

  return {
    ok: violations.length === 0,
    policy_snapshot_label: policySnapshotLabel,
    no_settings_in_ops_nav: noSettingsInOpsNav,
    ownership_intro_present: ownershipLib.includes("POLICY_SNAPSHOT_INTRO"),
    owner_links_present: ownerLinks,
    no_writable_controls: noWritable,
    violations,
  };
}

function platformAccessUntouched(root: string): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const abs = path.join(root, "app/platform/access");
  if (!fs.existsSync(abs)) return { ok: true, violations: [] };
  for (const file of walkFiles(abs)) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("claim-center") || text.includes("ClaimCenter")) {
      violations.push(`${rel} references claim-center`);
    }
  }
  return { ok: violations.length === 0, violations };
}

function claimCenterWriteActionsHidden(root: string): { ok: boolean; hits: string[] } {
  const hits: string[] = [];
  const ccDir = path.join(root, "components/claim-center");
  const appDir = path.join(root, "app/claim-center");
  for (const file of [...walkFiles(ccDir), ...walkFiles(appDir)]) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    const text = fs.readFileSync(file, "utf8");
    for (const pat of WRITE_ACTION_PATTERNS) {
      if (pat.test(text)) hits.push(`${rel} matches ${pat}`);
    }
  }
  return { ok: hits.length === 0, hits };
}

function dataUxChecks(root: string): {
  ok: boolean;
  data_readiness_banner: boolean;
  pool_empty_template: boolean;
  queue_clear_template: boolean;
  page_explanation_model: boolean;
  detail_practical_next_step: boolean;
  no_fake_data: boolean;
  plain_language_kpis: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const banner = read(root, "components/claim-center/ClaimCenterDataReadinessBanner.tsx");
  const uiCopy = read(root, "lib/claims/center/claim-center-ui-copy.ts");
  const pageContract = read(root, "lib/claims/center/claim-center-v2-page-contract.ts");
  const pageShell = read(root, "components/claim-center/ClaimCenterV2PageShell.tsx");
  const positionHeader = read(root, "components/claim-center/ClaimCenterFlowPositionHeader.tsx");
  const emptyState = read(root, "components/claim-center/ClaimCenterSectionEmptyState.tsx");
  const dashboard = read(root, "components/claim-center/ClaimCenterCommandDashboard.tsx");
  const detailBlocks = read(root, "components/claim-center/ClaimCenterDetailStoryBlocks.tsx");
  const detailStory = read(root, "lib/claims/center/claim-center-detail-story.ts");
  const sourcesView = read(root, "components/claim-center/ClaimCenterSourcesView.tsx");

  const dataReadinessBanner =
    banner.includes("No active claim opportunities generated for this workspace yet") &&
    banner.includes("data-readiness-banner") &&
    banner.includes("/claim-center/sources") &&
    banner.includes("Trusted sources");

  const poolEmptyTemplate =
    uiCopy.includes("CLAIM_CENTER_POOL_EMPTY_TEMPLATE") &&
    uiCopy.includes('variant: "pool_empty"') &&
    emptyState.includes('data-empty-variant={config.variant}') &&
    emptyState.includes("Pool empty");

  const queueClearTemplate =
    uiCopy.includes("CLAIM_CENTER_QUEUE_CLEAR_TEMPLATE") &&
    emptyState.includes("Queue clear");

  const pageExplanationModel =
    pageContract.includes("appearsHere") &&
    pageContract.includes("whatToDoNext") &&
    pageContract.includes("whyEmpty") &&
    pageShell.includes("ClaimCenterFlowPositionHeader") &&
    positionHeader.includes("You are here") &&
    positionHeader.includes("Data source");

  const detailPracticalNextStep =
    detailBlocks.includes("What you can review now") &&
    detailBlocks.includes("Locked for now") &&
    detailBlocks.includes("After the filing bridge") &&
    detailStory.includes("reviewNow") &&
    detailStory.includes("lockedActions");

  const fakePatterns = [/lorem ipsum/i, /demo data/i, /fake row/i, /placeholder candidate/i, /sample_uuid/i];
  const noFakeData =
    !fakePatterns.some((p) => p.test(dashboard + banner)) &&
    banner.includes("not demo") &&
    !dashboard.includes("MOCK_");

  const homeTiles = read(root, "components/claim-center/ClaimCenterCommandHomeTiles.tsx");
  const plainLanguageKpis =
    homeTiles.includes("Potential recovery") &&
    homeTiles.includes("Open exposure") &&
    homeTiles.includes("Not linked yet") &&
    (dashboard.includes("Cost unknown") || homeTiles.includes("Cost unknown")) &&
    !dashboard.includes("claim_candidates");

  const sourcesHumanCards =
    sourcesView.includes("data-source-card") &&
    sourcesView.includes("Opportunities created") &&
    sourcesView.includes("Next step:");

  if (!dataReadinessBanner) violations.push("Data readiness banner copy incomplete");
  if (!poolEmptyTemplate) violations.push("Pool empty template missing");
  if (!queueClearTemplate) violations.push("Queue clear template missing");
  if (!pageExplanationModel) violations.push("Page explanation model incomplete");
  if (!detailPracticalNextStep) violations.push("Detail practical next-step copy missing");
  if (!noFakeData) violations.push("Fake/demo data patterns detected");
  if (!plainLanguageKpis) violations.push("Plain-language KPI labels missing");
  if (!sourcesHumanCards) violations.push("Sources human cards incomplete");

  return {
    ok: violations.length === 0,
    data_readiness_banner: dataReadinessBanner,
    pool_empty_template: poolEmptyTemplate,
    queue_clear_template: queueClearTemplate,
    page_explanation_model: pageExplanationModel,
    detail_practical_next_step: detailPracticalNextStep,
    no_fake_data: noFakeData,
    plain_language_kpis: plainLanguageKpis,
    violations,
  };
}

function sectionPagesHaveEmptyStates(root: string): boolean {
  const aliasOrRedirect = new Set(["app/claim-center/settings/page.tsx", "app/claim-center/runs/page.tsx"]);
  const sectionPages = CLAIM_CENTER_ROUTES.filter(
    (r) => r !== "app/claim-center/page.tsx" && !aliasOrRedirect.has(r),
  );
  const dashboard = read(root, "app/claim-center/page.tsx");
  const dashboardOk = dashboard.includes("ClaimCenterCommandDashboard");
  const sectionOk = sectionPages.every((r) => {
    let text = read(root, r);
    if (r === "app/claim-center/opportunities/page.tsx") {
      text += read(root, "components/claim-center/ClaimCenterOpportunitiesView.tsx");
    }
    const dir = path.dirname(r);
    const base = path.basename(r, ".tsx");
    for (const ent of fs.readdirSync(path.join(root, dir))) {
      if (ent.endsWith(".tsx") && ent !== "page.tsx") {
        text += read(root, path.join(dir, ent));
      }
    }
    return (
      text.includes("ClaimCenterSectionEmptyState") ||
      text.includes("CLAIM_CENTER_SECTION_EMPTY") ||
      text.includes("CLAIM_CENTER_CANDIDATE_FILTERS") ||
      text.includes("ClaimCenterPageShell") ||
      text.includes("ClaimCenterV2PageShell") ||
      text.includes("ClaimCenterSourcesView")
    );
  });
  return dashboardOk && sectionOk;
}

async function countWritesBeforeAfter(admin: SupabaseClient) {
  const [c, e, s, cases] = await Promise.all([
    admin.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG),
    admin.from("claim_reference_edges").select("id", { count: "exact", head: true }).eq("organization_id", ORG),
    admin.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG),
    admin.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG),
  ]);
  return {
    candidates: c.count ?? 0,
    edges: e.count ?? 0,
    submissions: s.count ?? 0,
    cases: cases.count ?? 0,
  };
}

function staticChecks(root: string): Record<string, boolean | number | string[]> {
  const routesOk = CLAIM_CENTER_ROUTES.every((r) => fs.existsSync(path.join(root, r)));
  const uxFixOk = UX_FIX_COMPONENTS.every((r) => fs.existsSync(path.join(root, r)));
  const menorixOk = MENORIX_V2_COMPONENTS.every((r) => fs.existsSync(path.join(root, r)));
  const contractsOk = fs.existsSync(path.join(root, "lib/menorix/module-app-contracts.ts"));
  const mobileCardsOk = fs.existsSync(path.join(root, "components/claim-center/ClaimCenterMobileCards.tsx"));
  const legacyUntouched = !read(root, "app/claim-engine/inbox/ClaimInboxClient.tsx").includes("MenorixModuleAppShell");
  const scanner = scannerFilesUntouched(root);
  const writeHidden = claimCenterWriteActionsHidden(root);
  const emptyStates = sectionPagesHaveEmptyStates(root);
  const uiCopy = read(root, "lib/claims/center/claim-center-ui-copy.ts");
  const bridgeCopyOk = uiCopy.includes("filing bridge") || uiCopy.includes("write bridge");
  const hiddenRowsOk = uiCopy.includes("seed") && uiCopy.includes("quarantined");
  const dashboard = read(root, "components/claim-center/ClaimCenterCommandDashboard.tsx");
  const dataUx = dataUxChecks(root);
  const homeTilesKpi = read(root, "components/claim-center/ClaimCenterCommandHomeTiles.tsx");
  const moneyContract = read(root, "lib/claims/center/claim-center-money-contract.ts");
  const kpiLabelsOk =
    homeTilesKpi.includes("Potential recovery") &&
    homeTilesKpi.includes("observed reimbursement") &&
    moneyContract.includes("potential_recovery_unknown_count");
  const submissions = read(root, "app/claim-center/submissions/page.tsx");
  const legacySubmissionOk =
    submissions.includes("Legacy read-only") && submissions.includes("Legacy tools");
  const hubRoutes = read(root, "lib/claims-hub-routes.ts");
  const navSplitOk = hubRoutes.includes("isClaimCenterRoute") && hubRoutes.includes("isClaimCenterSidebarActive");

  const navConfig = read(root, "components/claim-center/claim-center-nav-config.ts");
  const shellV1Ok = SHELL_V1_COMPONENTS.every((r) => fs.existsSync(path.join(root, r)));
  const rootClient = read(root, "components/claim-center/ClaimCenterRootClient.tsx");
  const usesAppShell = rootClient.includes("ClaimCenterAppShell");
  const appShell = read(root, "components/claim-center/ClaimCenterAppShell.tsx");
  const singleNavOk = appShell.includes("showSectionTabs={false}") && appShell.includes("fullWidth");
  const flowNav = flowNavChecks(root);
  const mobilePolish = mobilePolishChecks(root);
  const commandHome = commandHomeV2Checks(root);
  const queueSemantics = queueSemanticsChecks(root);
  const physicalReturnMvp = physicalReturnMvpChecks(root);
  const policyReadModel = policyReadModelChecks(root);
  const policyOwnership = policyOwnershipChecks(root);
  const legacyBoundary = legacyBoundaryChecks(root);
  const reviewFilterNavOk =
    navConfig.includes("filter=needs_review") &&
    !navConfig.includes('href: "/claim-center/review"');
  const reviewPage = read(root, "app/claim-center/review/page.tsx");
  const reviewAliasClient = fs.existsSync(path.join(root, "app/claim-center/review/ClaimCenterReviewAliasClient.tsx"))
    ? read(root, "app/claim-center/review/ClaimCenterReviewAliasClient.tsx")
    : "";
  const reviewAliasOk =
    reviewAliasClient.includes("filter=needs_review") &&
    reviewAliasClient.includes("CLAIM_CENTER_CANDIDATE_FILTERS") &&
    !reviewPage.includes("redirect(");
  const groupBuilder = read(root, "app/claim-center/group-builder/page.tsx");
  const railSectionGb = navConfig.match(/export const CLAIM_CENTER_RAIL_GROUPS[\s\S]*?\];/)?.[0] ?? "";
  const groupBuilderShellOk =
    groupBuilder.includes("Legacy launcher") &&
    groupBuilder.includes("/returns/claims") &&
    groupBuilder.includes("ClaimCenterV2PageShell") &&
    !railSectionGb.includes("/claim-center/group-builder") &&
    !/Create case/i.test(groupBuilder);
  const fullWidthLayoutOk =
    read(root, "components/claim-center/claim-center-ui.ts").includes("w-full min-w-0") &&
    appShell.includes("fullWidth");
  const detailStory = detailStoryChecks(root);
  const policiesOk = fs.existsSync(path.join(root, "app/claim-center/policies/page.tsx"));
  const groupBuilderOk = fs.existsSync(path.join(root, "app/claim-center/group-builder/page.tsx"));
  const platformAccess = platformAccessUntouched(root);
  const menorixShell = read(root, "components/menorix/MenorixModuleAppShell.tsx");
  const fullWidthPropOk = menorixShell.includes("fullWidth");

  return {
    claim_center_routes_present: routesOk,
    shell_v1_components_present: shellV1Ok,
    claim_center_app_shell_wired: usesAppShell,
    single_nav_no_section_tabs: singleNavOk,
    workflow_bar_present: flowNav.workflow_bar_present,
    desktop_rail_removed: flowNav.desktop_rail_removed,
    hide_rail_shell: flowNav.hide_rail_shell,
    you_are_here_header: flowNav.you_are_here_header,
    workflow_steps_seven: flowNav.workflow_steps_seven,
    menu_in_menu_removed: flowNav.menu_in_menu_removed,
    lifecycle_flow_strip: flowNav.lifecycle_flow_strip,
    flow_nav_ok: flowNav.ok,
    flow_nav_violations: flowNav.violations,
    mobile_lifecycle_header: mobilePolish.mobile_lifecycle_header,
    more_sheet_purpose: mobilePolish.more_sheet_purpose,
    mobile_cards_rich: mobilePolish.mobile_cards_rich,
    mobile_detail_summary: mobilePolish.mobile_detail_summary,
    empty_state_safe_action: mobilePolish.empty_state_safe_action,
    mobile_polish_ok: mobilePolish.ok,
    mobile_polish_violations: mobilePolish.violations,
    command_home_v2_ok: commandHome.ok,
    queue_semantics_ok: queueSemantics.ok,
    queue_semantics_module: queueSemantics.queue_semantics_module,
    money_projection_module: queueSemantics.money_projection_module,
    twin_grouping_ui: queueSemantics.twin_grouping_ui,
    opportunities_includes_blocked: queueSemantics.opportunities_includes_blocked,
    recovery_observed_only: queueSemantics.recovery_observed_only,
    evidence_route: queueSemantics.evidence_route,
    queue_semantics_violations: queueSemantics.violations,
    physical_return_mvp_ok: physicalReturnMvp.ok,
    physical_return_mvp_module: physicalReturnMvp.physical_return_mvp_module,
    mvp_filter_wired: physicalReturnMvp.mvp_filter_wired,
    operational_copy: physicalReturnMvp.operational_copy,
    detail_physical_story: physicalReturnMvp.detail_physical_story,
    physical_return_mvp_violations: physicalReturnMvp.violations,
    policy_read_model_ok: policyReadModel.ok,
    policy_contract_module: policyReadModel.policy_contract_module,
    derive_lifecycle: policyReadModel.derive_lifecycle,
    expiration_warning_policy: policyReadModel.expiration_warning_policy,
    sources_route: policyReadModel.sources_route,
    policy_context_handlers: policyReadModel.policy_context_handlers,
    policy_read_model_violations: policyReadModel.violations,
    command_board: commandHome.command_board,
    command_home_tiles: commandHome.command_home_tiles,
    attention_list: commandHome.attention_list,
    money_contract_module: commandHome.money_contract_module,
    no_fake_amount_sum: commandHome.no_fake_amount_sum,
    command_home_violations: commandHome.violations,
    review_filter_primary_nav: reviewFilterNavOk,
    review_alias_read_only: reviewAliasOk,
    group_builder_shell_ok: groupBuilderShellOk,
    full_width_layout_ok: fullWidthLayoutOk,
    detail_story_ok: detailStory.ok,
    detail_six_blocks_present: detailStory.six_blocks_present,
    detail_sticky_header_present: detailStory.sticky_header_present,
    detail_wide_desktop_drawer: detailStory.wide_desktop_drawer,
    detail_no_write_buttons: detailStory.no_write_buttons,
    detail_story_violations: detailStory.violations,
    policies_route_present: policiesOk,
    group_builder_route_present: groupBuilderOk,
    full_width_shell_prop: fullWidthPropOk,
    platform_access_untouched: platformAccess.ok,
    platform_access_violations: platformAccess.violations,
    ux_fix_components_present: uxFixOk,
    menorix_v2_components_present: menorixOk,
    module_contracts_present: contractsOk,
    mobile_card_component_present: mobileCardsOk,
    legacy_claim_engine_not_patched: legacyUntouched,
    scanner_files_untouched: scanner.ok,
    scanner_files_scanned: scanner.scanned,
    scanner_violations: scanner.violations,
    write_actions_hidden: writeHidden.ok,
    write_action_hits: writeHidden.hits,
    section_empty_states_wired: emptyStates,
    bridge_phase_copy_present: bridgeCopyOk,
    hidden_rows_copy_present: hiddenRowsOk,
    kpi_external_labels_ok: kpiLabelsOk,
    legacy_submission_copy_ok: legacySubmissionOk,
    claim_center_nav_split_ok: navSplitOk,
    policy_ownership_ok: policyOwnership.ok,
    policy_snapshot_label: policyOwnership.policy_snapshot_label,
    no_settings_in_ops_nav: policyOwnership.no_settings_in_ops_nav,
    ownership_intro_present: policyOwnership.ownership_intro_present,
    owner_links_present: policyOwnership.owner_links_present,
    policy_snapshot_no_writable_controls: policyOwnership.no_writable_controls,
    policy_ownership_violations: policyOwnership.violations,
    legacy_boundary_ok: legacyBoundary.ok,
    workflow_nav_eight: legacyBoundary.workflow_nav_eight,
    mobile_bottom_three: legacyBoundary.mobile_bottom_three,
    legacy_tools_menu: legacyBoundary.legacy_tools_menu,
    no_external_rail: legacyBoundary.no_external_rail,
    dashboard_four_tiles: legacyBoundary.dashboard_four_tiles,
    no_legacy_in_detail_cta: legacyBoundary.no_legacy_in_detail_cta,
    legacy_boundary_violations: legacyBoundary.violations,
    data_readiness_banner: dataUx.data_readiness_banner,
    pool_empty_template: dataUx.pool_empty_template,
    queue_clear_template: dataUx.queue_clear_template,
    page_explanation_model: dataUx.page_explanation_model,
    detail_practical_next_step: dataUx.detail_practical_next_step,
    no_fake_data: dataUx.no_fake_data,
    plain_language_kpis: dataUx.plain_language_kpis,
    data_ux_ok: dataUx.ok,
    data_ux_violations: dataUx.violations,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  if (refFromSupabaseUrl(url) !== STAGING_REF) {
    throw new Error(`Expected staging ref ${STAGING_REF}`);
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const root = process.cwd();

  const staticResult = staticChecks(root);
  const allStatic =
    staticResult.claim_center_routes_present === true &&
    staticResult.shell_v1_components_present === true &&
    staticResult.claim_center_app_shell_wired === true &&
    staticResult.single_nav_no_section_tabs === true &&
    staticResult.flow_nav_ok === true &&
    staticResult.mobile_polish_ok === true &&
    staticResult.command_home_v2_ok === true &&
    staticResult.queue_semantics_ok === true &&
    staticResult.physical_return_mvp_ok === true &&
    staticResult.policy_read_model_ok === true &&
    staticResult.review_filter_primary_nav === true &&
    staticResult.review_alias_read_only === true &&
    staticResult.group_builder_shell_ok === true &&
    staticResult.full_width_layout_ok === true &&
    staticResult.detail_story_ok === true &&
    staticResult.legacy_boundary_ok === true &&
    staticResult.policies_route_present === true &&
    staticResult.group_builder_route_present === true &&
    staticResult.full_width_shell_prop === true &&
    staticResult.platform_access_untouched === true &&
    staticResult.ux_fix_components_present === true &&
    staticResult.menorix_v2_components_present === true &&
    staticResult.module_contracts_present === true &&
    staticResult.mobile_card_component_present === true &&
    staticResult.legacy_claim_engine_not_patched === true &&
    staticResult.scanner_files_untouched === true &&
    staticResult.write_actions_hidden === true &&
    staticResult.section_empty_states_wired === true &&
    staticResult.bridge_phase_copy_present === true &&
    staticResult.kpi_external_labels_ok === true &&
    staticResult.legacy_submission_copy_ok === true &&
    staticResult.claim_center_nav_split_ok === true &&
    staticResult.policy_ownership_ok === true &&
    staticResult.data_ux_ok === true;

  const {
    getCenterDashboardPayload,
    getCenterOpportunitiesPayload,
    getCenterReviewPayload,
    getCenterReferencesPayload,
    getCenterProductLinkagePayload,
    getCenterRecoveryPayload,
    getCenterRunsPayload,
    getCenterSubmissionsPayload,
    fetchCenterCandidateRows,
    getCenterModuleAccessPayload,
    getCenterAiAccessPayload,
    getCenterAutomationHealthPayload,
    getCenterEvidencePayload,
    getCenterSourcesPayload,
  } = await import("../lib/claims/center/claim-center-api-handlers");

  const { evaluateMenorixAiModuleAccess } = await import("../lib/menorix/evaluate-menorix-ai-module-access");

  const before = await countWritesBeforeAfter(admin);
  const checks: Record<string, unknown> = { static: staticResult };

  checks.module_access = await getCenterModuleAccessPayload(ORG);
  checks.dashboard = await getCenterDashboardPayload(ORG, null);
  checks.opportunities = await getCenterOpportunitiesPayload(ORG, null, 20);
  checks.review = await getCenterReviewPayload(ORG, null, 20);
  checks.evidence = await getCenterEvidencePayload(ORG, null, 20);
  checks.sources = await getCenterSourcesPayload(ORG, null);
  checks.references = await getCenterReferencesPayload(ORG, null, null, 20);
  checks.product_linkage = await getCenterProductLinkagePayload(ORG, null, 20);
  checks.recovery = await getCenterRecoveryPayload(ORG, null, 20);
  checks.runs = await getCenterRunsPayload(ORG, null);
  checks.submissions = await getCenterSubmissionsPayload(ORG, null, 20);
  checks.inbox_center_v1 = await fetchCenterCandidateRows(ORG, { storeId: null, limit: 25 });
  checks.ai_access = await getCenterAiAccessPayload(ORG);
  checks.automation_health = await getCenterAutomationHealthPayload(ORG, null);
  checks.ai_gate_direct = await evaluateMenorixAiModuleAccess(admin, ORG);

  const after = await countWritesBeforeAfter(admin);
  const zero_writes =
    before.candidates === after.candidates &&
    before.edges === after.edges &&
    before.submissions === after.submissions &&
    before.cases === after.cases;

  const moduleEnabled = !!(checks.module_access as { enabled?: boolean }).enabled;
  const aiStates = new Set(["locked", "setup_required", "ready"]);
  const aiOk = aiStates.has(String((checks.ai_access as { state?: string }).state));

  const dash = checks.dashboard as {
    meta?: { is_sample_capped?: boolean; sample_limit?: number };
    kpis?: Record<string, unknown>;
  };
  const metaOk =
    dash.meta != null &&
    typeof dash.meta.sample_limit === "number" &&
    typeof dash.kpis?.observed_filed_count === "number" &&
    typeof dash.kpis?.ready_to_file_count === "number" &&
    typeof (dash.kpis?.money as { potential_recovery_unknown_count?: number } | undefined)
      ?.potential_recovery_unknown_count === "number" &&
    typeof (dash.kpis?.queue_counts as { find_money_count?: number } | undefined)?.find_money_count ===
      "number";

  const opp = checks.opportunities as { items?: unknown[]; queue_counts?: { find_money_count?: number } };
  const rec = checks.recovery as { items?: unknown[]; empty_message?: string | null };
  const refs = checks.references as { references_not_materialized?: boolean };
  const inbox = checks.inbox_center_v1 as Array<{
    money_display?: { amount_display_label?: string; amount_basis?: string };
    lifecycle_status?: string;
    policy_warnings?: { codes?: string[] };
    physical_return_display?: { physical_return_mvp?: boolean };
    twin_group_key?: string | null;
    source_kind?: string;
  }>;
  const dashPolicy = (checks.dashboard as { policy_context?: { effective_policy?: { expiration_warning_days?: number } } })
    .policy_context;
  const policyReadModelOk =
    dashPolicy?.effective_policy?.expiration_warning_days != null &&
    inbox.length > 0 &&
    inbox.every((r) => typeof r.lifecycle_status === "string") &&
    inbox.some((r) => Array.isArray(r.policy_warnings?.codes));

  const allowedMoneyLabels = new Set([
    "Cost unknown",
    "Unpriced — add cost to see recovery",
    "Observed (no amount)",
  ]);
  const moneyLabelOk = (label: string | undefined) =>
    !!label && (allowedMoneyLabels.has(label) || /^\$[\d,]+/.test(label));

  const physicalReturnStagingOk =
    inbox.length === 4 &&
    inbox.every((r) => r.physical_return_display?.physical_return_mvp === true) &&
    inbox.some((r) => r.twin_group_key) &&
    inbox.filter((r) => r.source_kind === "scanner_physical_review").length === 2 &&
    inbox.filter((r) => r.source_kind === "orbit_fra").length === 2 &&
    inbox.every((r) => moneyLabelOk(r.money_display?.amount_display_label)) &&
    inbox.every((r) => r.money_display?.amount_display_label !== "$0");

  const groupedPhysicalRows = new Set(inbox.map((r) => r.twin_group_key).filter(Boolean)).size;

  const queueAlignmentOk =
    (opp.items?.length ?? 0) > 0 &&
    (opp.items?.length ?? 0) === (opp.queue_counts?.find_money_count ?? -1) &&
    (rec.items?.length ?? 0) === 0 &&
    rec.empty_message === "No observed reimbursements linked yet." &&
    physicalReturnStagingOk &&
    (refs.references_not_materialized === true || (refs as { items?: unknown[] }).items?.length === 0);

  const runId = stamp();
  const outDir = path.join(OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const safeToProceedReadUx =
    zero_writes && allStatic && aiOk && metaOk && staticResult.scanner_files_untouched === true;
  const summary = {
    audit: "PHASE-CLAIM-PHYSICAL-RETURN-MVP-READMODEL-IMPLEMENT-V1-STAGING-SMOKE",
    run_id: runId,
    organization_id: ORG,
    zero_writes,
    static_checks_pass: allStatic,
    scanner_files_changed_must_be_empty: staticResult.scanner_files_untouched === true,
    module_gate_ok: moduleEnabled,
    ai_gate_ok: aiOk,
    dashboard_meta_ok: metaOk,
    queue_alignment_ok: queueAlignmentOk,
    policy_read_model_staging_ok: policyReadModelOk,
    physical_return_staging_ok: physicalReturnStagingOk,
    grouped_physical_rows: groupedPhysicalRows,
    staging_candidate_count: inbox.length,
    counts_before: before,
    counts_after: after,
    safe_to_proceed_to_write_actions: safeToProceedReadUx ? "conditional_yes_read_ux_only" : "no",
    safe_to_push: zero_writes && allStatic && aiOk && metaOk && queueAlignmentOk && policyReadModelOk && physicalReturnStagingOk,
  };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ summary, checks }, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    `# Claim Center shell V1 smoke\n\n- zero_writes: **${zero_writes}**\n- static: **${allStatic}**\n- scanner untouched: **${staticResult.scanner_files_untouched}**\n- platform access untouched: **${staticResult.platform_access_untouched}**\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
  if (!zero_writes || !allStatic || !metaOk || !queueAlignmentOk || !policyReadModelOk || !physicalReturnStagingOk) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
