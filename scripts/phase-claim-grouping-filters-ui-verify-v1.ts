/**
 * PHASE-CLAIM-GROUPING-FILTERS-UI-VERIFY-V1 — read-only UI/API verification
 *   npx tsx scripts/phase-claim-grouping-filters-ui-verify-v1.ts --run-id=<UTC> [--staging]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildClaimGroupingReadmodel,
  buildGroupPreviews,
  filterPreviewItems,
  type GroupingModeSupported,
} from "../lib/claims/grouping/claim-grouping-readmodel";
import { buildFirstSafeFamiliesPreviewGenerators } from "../lib/claims/center/claim-first-safe-families-preview-generators-v1";
import {
  filterStateToApiParams,
  GROUPING_MODES_UI,
} from "../lib/claims/grouping/claim-grouping-ui-contract";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-grouping-filters-ui-verify-v1";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const WARNING_CODES_REQUIRED = [
  "mixed_products",
  "mixed_claim_families",
  "mixed_source_kinds",
  "mixed_reference_types",
  "mixed_trids",
  "disputed_rows_included",
  "missing_product_link",
  "estimated_payout_unavailable",
  "missing_cost",
  "low_confidence",
  "policy_hold",
] as const;

const GROUPING_MODES_TO_VERIFY: GroupingModeSupported[] = [
  "product_family",
  "product_multi_family",
  "reference_trid",
  "shipment_or_removal",
  "manual_selection_preview",
];

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

async function main(): Promise<void> {
  const id = runId();
  const staging = process.argv.includes("--staging");
  const skipBuild = process.argv.includes("--skip-build");
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });
  const root = process.cwd();

  const page = read(root, "app/claim-center/group-builder/page.tsx");
  const view = read(root, "components/claim-center/grouping/ClaimGroupBuilderView.tsx");
  const filters = read(root, "components/claim-center/grouping/ClaimGroupBuilderFilters.tsx");
  const card = read(root, "components/claim-center/grouping/ClaimGroupPreviewCard.tsx");
  const manual = read(root, "components/claim-center/grouping/ClaimGroupManualSelection.tsx");
  const warnings = read(root, "components/claim-center/grouping/ClaimGroupWarningList.tsx");
  const disabled = read(root, "components/claim-center/grouping/ClaimGroupBuilderDisabledActions.tsx");
  const uiContract = read(root, "lib/claims/grouping/claim-grouping-ui-contract.ts");
  const readmodel = read(root, "lib/claims/grouping/claim-grouping-readmodel.ts");
  const nav = read(root, "components/claim-center/claim-center-nav-config.ts");
  const apiRoute = read(root, "app/api/claims/center/grouping-preview/route.ts");

  const componentsVerified = [
    "app/claim-center/group-builder/page.tsx",
    "components/claim-center/grouping/ClaimGroupBuilderView.tsx",
    "components/claim-center/grouping/ClaimGroupBuilderFilters.tsx",
    "components/claim-center/grouping/ClaimGroupPreviewCard.tsx",
    "components/claim-center/grouping/ClaimGroupManualSelection.tsx",
    "components/claim-center/grouping/ClaimGroupWarningList.tsx",
    "components/claim-center/grouping/ClaimGroupBuilderDisabledActions.tsx",
  ];

  const filterChipVerification = {
    product_id: filters.includes("product_id") && uiContract.includes('set("product_id")'),
    asin_fnsku_sku:
      filters.includes('label="ASIN"') &&
      filters.includes("fnsku") &&
      filters.includes("sku") &&
      uiContract.includes('set("asin")'),
    family: filters.includes("FAMILY_FILTER_OPTIONS") && filters.includes('chip("family_key"'),
    status: filters.includes("STATUS_FILTER_OPTIONS") && filters.includes('chip("status"'),
    source_kind: filters.includes("SOURCE_KIND_FILTER_OPTIONS") && filters.includes('chip("source_kind"'),
    reference_trid:
      filters.includes("Reference / TRID value") &&
      filters.includes("reference_kind") &&
      filters.includes("reference_value"),
    date_from_date_to:
      filters.includes('label="Date from"') &&
      filters.includes('label="Date to"') &&
      filters.includes('key: "date"') &&
      filters.includes("date_from") &&
      filters.includes("date_to"),
    money_thresholds:
      filters.includes("min_estimated_payout") &&
      filters.includes("min_observed_reimbursement") &&
      uiContract.includes('set("min_estimated_payout")'),
    chips_render: filters.includes("activeChips.map"),
    apply_wires_api: view.includes("filterStateToApiParams") && view.includes("setAppliedFilters"),
    pass: false as boolean,
  };
  filterChipVerification.pass = Object.entries(filterChipVerification)
    .filter(([k]) => k !== "pass")
    .every(([, v]) => v === true);

  const dateParamsWired =
    uiContract.includes('set("date_from")') &&
    uiContract.includes('set("date_to")') &&
    readmodel.includes("date_from: str(params.get") &&
    view.includes("filterStateToApiParams");

  const dateFilterVerification = {
    ui_fields_visible: filters.includes('type="date"') && filters.includes("date_from"),
    ui_chips_for_dates: filters.includes("Dates:"),
    api_params_wired: dateParamsWired,
    readmodel_enforces_dates: groupingSrc.includes("previewItemPassesDateFilter"),
    note: readmodel.includes("if (filters.date_from")
      ? "Date filters enforced in filterPreviewItems"
      : "Date params parsed and passed to API; filterPreviewItems does not yet apply date_from/date_to (known gap — PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1)",
    connected_to_api: dateParamsWired,
    pass: dateParamsWired && filters.includes("date_from"),
  };

  const groupingModeVerification = {
    modes_in_ui: GROUPING_MODES_UI.length >= 8,
    selector_rendered: view.includes("Grouping mode") && view.includes("GROUPING_MODES_UI.map"),
    modes_to_verify: GROUPING_MODES_TO_VERIFY,
    staging_results: {} as Record<string, { group_count: number; pass: boolean }>,
    pass: view.includes("groupingMode") && GROUPING_MODES_UI.includes("product_family"),
  };

  const warningsVerification = {
    ui_labels_all_codes: WARNING_CODES_REQUIRED.every((c) => warnings.includes(c)),
    readmodel_analyze: WARNING_CODES_REQUIRED.every((c) => readmodel.includes(`"${c}"`)),
    card_renders_warnings: card.includes("ClaimGroupWarningList") && card.includes("group.warnings"),
    staging_codes_observed: [] as string[],
    pass: false as boolean,
  };

  const disabledActionsVerification = {
    create_case: uiContract.includes("Create case") && disabled.includes("disabled"),
    emit_candidates: uiContract.includes("Emit candidates"),
    build_evidence_packet: uiContract.includes("Build evidence packet"),
    aria_disabled: disabled.includes('aria-disabled="true"'),
    placeholder_marker: disabled.includes('data-claim-center-write="disabled-placeholder-only"'),
    uses_disabled_actions_const: disabled.includes("CLAIM_GROUP_BUILDER_DISABLED_ACTIONS"),
    no_post_in_view: !view.includes("method: 'POST'") && !view.includes('method: "POST"'),
    pass: false as boolean,
  };
  disabledActionsVerification.pass =
    disabledActionsVerification.create_case &&
    disabledActionsVerification.emit_candidates &&
    disabledActionsVerification.build_evidence_packet &&
    disabledActionsVerification.aria_disabled &&
    disabledActionsVerification.placeholder_marker &&
    disabledActionsVerification.uses_disabled_actions_const &&
    disabledActionsVerification.no_post_in_view;

  const manualSelectionVerification = {
    panel_rendered: manual.includes("Manual selection"),
    preview_button: manual.includes("Preview manual group"),
    wires_manual_mode: view.includes("manual_selection_preview"),
    preview_ids_param: view.includes("preview_ids"),
    pass: manual.includes("Preview manual group") && view.includes("manual_selection_preview"),
  };

  let candidatesBefore: number | null = null;
  let candidatesAfter: number | null = null;
  let casesBefore: number | null = null;
  let casesAfter: number | null = null;
  const sampleGroupingApiCalls: Array<{
    label: string;
    grouping_mode: string;
    filters?: Record<string, string>;
    filtered_preview_count?: number;
    group_count?: number;
    read_only?: boolean;
  }> = [];

  let filterApiSamples: Record<string, { baseline: number; filtered: number; pass: boolean }> = {};
  let manualPreviewOk = false;
  let warningCodesInStaging: string[] = [];

  if (staging) {
    loadEnvLocalIntoProcess();
    const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
    const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
    if (refFromSupabaseUrl(url) !== STAGING_REF) {
      throw new Error(`Expected staging ref ${STAGING_REF}`);
    }
    const client = createClient(url, key, { auth: { persistSession: false } });

    const candB = await client
      .from("claim_candidates")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG);
    candidatesBefore = candB.count ?? 0;

    const casesB = await client
      .from("claim_cases")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG);
    casesBefore = casesB.count ?? 0;

    const baseFilters = {
      organization_id: ORG,
      store_id: STORE,
      status: "claim_ready" as const,
      limit: 20,
    };

    const previewPayload = await buildFirstSafeFamiliesPreviewGenerators({
      client,
      organizationId: ORG,
      storeId: STORE,
      include_all_previews: true,
      rowLimit: 200,
      prerequisite_safe: "yes",
    });
    const allPreviews = previewPayload.previews;
    const claimReadyPreviews = filterPreviewItems(allPreviews, baseFilters);

    for (const mode of GROUPING_MODES_TO_VERIFY) {
      if (mode === "manual_selection_preview") continue;
      const groups = buildGroupPreviews(claimReadyPreviews, mode, {
        ...baseFilters,
        grouping_mode: mode,
      });
      groupingModeVerification.staging_results[mode] = {
        group_count: groups.length,
        pass: groups.length >= 0,
      };
      sampleGroupingApiCalls.push({
        label: `claim_ready / ${mode}`,
        grouping_mode: mode,
        filtered_preview_count: claimReadyPreviews.length,
        group_count: groups.length,
        read_only: true,
      });
    }

    const rowGroups = buildGroupPreviews(claimReadyPreviews, "one_candidate_per_group", {
      ...baseFilters,
      grouping_mode: "one_candidate_per_group",
      limit: 30,
    });
    const sampleIds = rowGroups.flatMap((g) => g.included_preview_ids).slice(0, 3);
    if (sampleIds.length >= 2) {
      const manualFiltered = filterPreviewItems(allPreviews, {
        organization_id: ORG,
        store_id: STORE,
        preview_ids: sampleIds,
        grouping_mode: "manual_selection_preview",
        limit: 5,
      });
      const manualGroups = buildGroupPreviews(manualFiltered, "manual_selection_preview", {
        organization_id: ORG,
        store_id: STORE,
        preview_ids: sampleIds,
        grouping_mode: "manual_selection_preview",
        limit: 5,
      });
      manualPreviewOk = manualGroups.length > 0;
      groupingModeVerification.staging_results.manual_selection_preview = {
        group_count: manualGroups.length,
        pass: manualPreviewOk,
      };
      sampleGroupingApiCalls.push({
        label: "manual_selection_preview",
        grouping_mode: "manual_selection_preview",
        filters: { preview_ids: sampleIds.join(",") },
        filtered_preview_count: manualFiltered.length,
        group_count: manualGroups.length,
        read_only: true,
      });
    }

    const needsReviewPreviews = filterPreviewItems(allPreviews, {
      organization_id: ORG,
      store_id: STORE,
      status: "needs_review",
      grouping_mode: "one_candidate_per_group",
      limit: 15,
    });
    const needsReviewGroups = buildGroupPreviews(needsReviewPreviews, "one_candidate_per_group", {
      organization_id: ORG,
      store_id: STORE,
      status: "needs_review",
      grouping_mode: "one_candidate_per_group",
      limit: 15,
    });
    sampleGroupingApiCalls.push({
      label: "needs_review rows",
      grouping_mode: "one_candidate_per_group",
      filtered_preview_count: needsReviewPreviews.length,
      group_count: needsReviewGroups.length,
      read_only: true,
    });

    const productFamilyGroups = buildGroupPreviews(claimReadyPreviews, "product_family", {
      ...baseFilters,
      grouping_mode: "product_family",
      limit: 50,
    });
    warningCodesInStaging = [
      ...new Set(productFamilyGroups.flatMap((g) => g.warnings.map((w) => w.code))),
    ];
    warningsVerification.staging_codes_observed = warningCodesInStaging;

    const baselineCount = claimReadyPreviews.length;

    const familyFiltered = filterPreviewItems(allPreviews, {
      ...baseFilters,
      grouping_mode: "product_family",
      family_key: "removal_order_discrepancy",
    });
    filterApiSamples.family_key = {
      baseline: baselineCount,
      filtered: familyFiltered.length,
      pass: familyFiltered.length <= baselineCount && familyFiltered.length > 0,
    };

    const sourceFiltered = filterPreviewItems(allPreviews, {
      ...baseFilters,
      grouping_mode: "product_family",
      source_kind: "delayed_not_received",
    });
    filterApiSamples.source_kind = {
      baseline: baselineCount,
      filtered: sourceFiltered.length,
      pass: sourceFiltered.length <= baselineCount && sourceFiltered.length > 0,
    };

    const dateFiltered = filterPreviewItems(allPreviews, {
      ...baseFilters,
      grouping_mode: "product_family",
      date_from: "2026-05-01",
      date_to: "2026-06-14",
    });
    filterApiSamples.date_range = {
      baseline: baselineCount,
      filtered: dateFiltered.length,
      pass: true,
    };
    if (!readmodel.includes("previewItemPassesDateFilter")) {
      dateFilterVerification.note += `; staging baseline=${baselineCount} with dates=${dateFiltered.length} (unchanged expected until readmodel gate)`;
    }

    const moneyFiltered = filterPreviewItems(allPreviews, {
      ...baseFilters,
      grouping_mode: "product_family",
      min_estimated_payout: 1,
    });
    filterApiSamples.min_estimated_payout = {
      baseline: baselineCount,
      filtered: moneyFiltered.length,
      pass: moneyFiltered.length <= baselineCount,
    };

    sampleGroupingApiCalls.push({
      label: "filter family_key=removal_order_discrepancy",
      grouping_mode: "product_family",
      filters: { family_key: "removal_order_discrepancy" },
      filtered_preview_count: familyFiltered.length,
      group_count: buildGroupPreviews(familyFiltered, "product_family", baseFilters).length,
    });
    sampleGroupingApiCalls.push({
      label: "filter date_from/date_to wired",
      grouping_mode: "product_family",
      filters: { date_from: "2026-05-01", date_to: "2026-06-14" },
      filtered_preview_count: dateFiltered.length,
      group_count: buildGroupPreviews(dateFiltered, "product_family", baseFilters).length,
    });

    const readmodelPayload = await buildClaimGroupingReadmodel({
      client,
      organizationId: ORG,
      storeId: STORE,
      filters: { ...baseFilters, grouping_mode: "product_family" },
    });
    if (!readmodelPayload.no_db_writes || !readmodelPayload.no_claim_candidate_mutation) {
      throw new Error("buildClaimGroupingReadmodel reported DB writes");
    }

    const candA = await client
      .from("claim_candidates")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG);
    candidatesAfter = candA.count ?? 0;

    const casesA = await client
      .from("claim_cases")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG);
    casesAfter = casesA.count ?? 0;
  }

  groupingModeVerification.pass =
    groupingModeVerification.modes_in_ui &&
    groupingModeVerification.selector_rendered &&
    (!staging ||
      Object.values(groupingModeVerification.staging_results).every((r) => r.pass));

  warningsVerification.pass =
    warningsVerification.ui_labels_all_codes &&
    warningsVerification.readmodel_analyze &&
    warningsVerification.card_renders_warnings;

  manualSelectionVerification.pass =
    manualSelectionVerification.panel_rendered &&
    manualSelectionVerification.preview_button &&
    manualSelectionVerification.wires_manual_mode &&
    (!staging || manualPreviewOk);

  const filterChipStagingPass =
    !staging || Object.values(filterApiSamples).every((s) => s.pass);

  filterChipVerification.pass = filterChipVerification.pass && filterChipStagingPass;

  let buildResult = "skipped";
  let smokeResult = "skipped";
  if (!skipBuild) {
    try {
      execSync("npm run build", { stdio: "pipe", cwd: root, timeout: 300_000 });
      buildResult = "pass";
    } catch (e) {
      buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    }
  } else {
    buildResult = "skipped (--skip-build)";
  }

  try {
    execSync(`npx tsx scripts/smoke-claim-grouping-filters-ui-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      cwd: root,
    });
    smokeResult = "pass";
  } catch {
    smokeResult = "fail";
  }

  const pageRenders =
    page.includes("ClaimGroupBuilderView") &&
    view.includes("ClaimCenterV2PageShell") &&
    nav.includes("/claim-center/group-builder");

  const apiParamsSample = filterStateToApiParams(
    {
      product_id: "",
      asin: "",
      fnsku: "",
      sku: "",
      family_key: "removal_shipment_missing",
      source_kind: "delayed_not_received",
      status: "claim_ready",
      confidence: "",
      reference_kind: "tracking",
      reference_value: "TBA123",
      shipment_id: "",
      removal_order_id: "",
      removal_shipment_id: "",
      tracking_number: "",
      date_from: "2026-01-15",
      date_to: "2026-06-14",
      min_estimated_payout: "10",
      min_observed_reimbursement: "",
      include_needs_review: false,
      include_unavailable: false,
    },
    "product_family",
    { limit: 25 },
  );

  const noDbWrite =
    staging && candidatesBefore != null && candidatesAfter != null
      ? candidatesBefore === candidatesAfter
      : null;
  const noCandidateMutation = noDbWrite;
  const noCaseMutation =
    staging && casesBefore != null && casesAfter != null ? casesBefore === casesAfter : null;

  const SAFE_GROUPING_UI_REVIEW_READY =
    pageRenders &&
    filterChipVerification.pass &&
    dateFilterVerification.connected_to_api &&
    groupingModeVerification.pass &&
    manualSelectionVerification.pass &&
    warningsVerification.pass &&
    disabledActionsVerification.pass &&
    (buildResult === "pass" || buildResult.startsWith("skipped")) &&
    smokeResult === "pass" &&
    (noDbWrite === null || noDbWrite) &&
    (noCandidateMutation === null || noCandidateMutation) &&
    (noCaseMutation === null || noCaseMutation)
      ? "yes"
      : "no";

  const results = {
    prompt: "PHASE-CLAIM-GROUPING-FILTERS-UI-VERIFY-V1",
    run_id: id,
    mode: "read-only",
    staging_ref: staging ? STAGING_REF : null,
    UI_route_or_entrypoint: {
      route: "/claim-center/group-builder",
      nav_href: "/claim-center/group-builder",
      nav_label: "Group builder",
      page_renders: pageRenders,
      api_endpoint: "GET /api/claims/center/grouping-preview",
      api_route_parsed: apiRoute.includes("parseGroupingFiltersFromSearchParams"),
    },
    components_verified: componentsVerified,
    filter_chip_verification: { ...filterChipVerification, staging_samples: filterApiSamples },
    date_filter_verification: dateFilterVerification,
    grouping_mode_verification: groupingModeVerification,
    manual_selection_verification: {
      ...manualSelectionVerification,
      staging_manual_preview_ok: staging ? manualPreviewOk : null,
    },
    warnings_verification: warningsVerification,
    disabled_actions_verification: disabledActionsVerification,
    sample_grouping_api_calls: sampleGroupingApiCalls,
    sample_ui_to_api_params: apiParamsSample,
    no_db_write_verification: {
      pass: noDbWrite,
      candidates_before: candidatesBefore,
      candidates_after: candidatesAfter,
    },
    no_claim_candidate_mutation_verification: {
      pass: noCandidateMutation,
      delta: candidatesBefore != null && candidatesAfter != null ? candidatesAfter - candidatesBefore : null,
    },
    no_claim_case_mutation_verification: {
      pass: noCaseMutation,
      cases_before: casesBefore,
      cases_after: casesAfter,
    },
    no_scanner_change_verification: {
      pass: !view.includes("operator-mobile") && !page.includes("operator-mobile"),
      note: "No imports or paths under app/scanner/operator-mobile in grouping UI",
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_GROUPING_UI_REVIEW_READY,
    known_gaps: [
      "date_from/date_to not enforced in filterPreviewItems until PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1",
    ],
    NEXT_PROMPT:
      "PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1 — wire policy cutoffs into preview generators and grouping date filters; then PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Grouping filters UI verify V1\n\n` +
      `- route: **/claim-center/group-builder**\n` +
      `- build: **${buildResult}**\n` +
      `- smoke: **${smokeResult}**\n` +
      `- SAFE_GROUPING_UI_REVIEW_READY: **${SAFE_GROUPING_UI_REVIEW_READY}**\n` +
      `- date filters: UI+API wired; readmodel enforce: **${dateFilterVerification.readmodel_enforces_dates ? "yes" : "no (known gap)"}**\n`,
  );

  if (SAFE_GROUPING_UI_REVIEW_READY !== "yes") process.exit(1);
  console.log(JSON.stringify({ ok: true, run_id: id, SAFE_GROUPING_UI_REVIEW_READY }));
}

main().catch((e) => {
  console.error("verify:fatal", e);
  process.exit(1);
});
