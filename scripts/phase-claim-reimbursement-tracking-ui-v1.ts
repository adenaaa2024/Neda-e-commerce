/**
 * PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-V1 — read-only UI verify + API parity
 *   npx tsx scripts/phase-claim-reimbursement-tracking-ui-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  composeReimbursementTrackingPreviewV1,
} from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import {
  CLAIM_CENTER_FINANCIAL_NAV,
} from "../lib/claims/submission/claim-reimbursement-tracking-nav";
import {
  REIMBURSEMENT_TRACKING_UI_VERSION,
  buildReimbursementTrackingUiPayload,
  filterReimbursementTrackingRows,
  type ReimbursementTrackingFilterState,
} from "../lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import type { ReimbursementTrackingPreviewRow } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-reimbursement-tracking-ui-v1";
const PREVIEW_RESULTS =
  ".cursor/audit-reports/phase-claim-reimbursement-tracking-preview-v1/20260617T130000Z/results.json";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const FILES_CHANGED = [
  "lib/claims/submission/claim-reimbursement-tracking-ui-contract.ts",
  "lib/claims/submission/claim-reimbursement-tracking-nav.ts",
  "lib/claims/center/claim-center-api-handlers.ts",
  "lib/claims/center/claim-center-v2-page-contract.ts",
  "app/api/claims/center/reimbursement-tracking/route.ts",
  "app/claim-center/reimbursement-tracking/page.tsx",
  "components/claim-center/financial/ClaimCenterFinancialNav.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingHeader.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingSummaryCards.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingWorkflowStrip.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingFilters.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingDisabledActions.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingCopyValue.tsx",
  "components/claim-center/claim-center-nav-config.ts",
  "scripts/phase-claim-reimbursement-tracking-ui-v1.ts",
  "scripts/smoke-claim-reimbursement-tracking-ui-v1.ts",
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

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

function fileExists(rel: string): boolean {
  return fs.existsSync(path.join(process.cwd(), rel));
}

function loadPreviewPrereq(): Record<string, unknown> {
  const p = path.join(process.cwd(), PREVIEW_RESULTS);
  if (!fs.existsSync(p)) {
    throw new Error(`BLOCKED: preview evidence missing at ${PREVIEW_RESULTS}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

function verifyFiltersSearch(rows: ReimbursementTrackingPreviewRow[]) {
  const all = rows;
  const shipment = filterReimbursementTrackingRows(all, {
    ...emptyFilters(),
    family_key_v3: "removal_shipment_missing",
  });
  const order = filterReimbursementTrackingRows(all, {
    ...emptyFilters(),
    family_key_v3: "removal_order_discrepancy",
  });
  const unmatched = filterReimbursementTrackingRows(all, { ...emptyFilters(), matched: "unmatched" });
  const moneyUnknown = filterReimbursementTrackingRows(all, { ...emptyFilters(), money_known: "unknown" });
  const sample = all[0];
  const byCase = sample
    ? filterReimbursementTrackingRows(all, { ...emptyFilters(), search: sample.claim_case_id.slice(0, 8) })
    : [];
  const byAsin = sample?.asin
    ? filterReimbursementTrackingRows(all, { ...emptyFilters(), search: sample.asin })
    : [];
  return {
    pass:
      shipment.length === 6 &&
      order.length === 4 &&
      unmatched.length === 10 &&
      moneyUnknown.length === 10 &&
      (sample ? byCase.length >= 1 : true) &&
      (sample?.asin ? byAsin.length >= 1 : true),
    family_shipment_count: shipment.length,
    family_order_count: order.length,
    unmatched_count: unmatched.length,
    money_unknown_count: moneyUnknown.length,
    search_case_hits: byCase.length,
    search_asin_hits: sample?.asin ? byAsin.length : null,
  };
}

function emptyFilters(): ReimbursementTrackingFilterState {
  return {
    pilot_case_run_id: "pilot-20260615T190000Z",
    intake_run_id: "a8a892fe-37d5-4d74-9ea2-02af8fd095ce",
    family_key_v3: "",
    submission_status: "",
    matched: "",
    needs_follow_up: "",
    money_known: "",
    match_confidence: "",
    date_from: "",
    date_to: "",
    search: "",
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const preview = loadPreviewPrereq();
  const previewReady = String(preview.SAFE_REIMBURSEMENT_TRACKING_PREVIEW_READY ?? "no");
  const safeUi = String(preview.SAFE_TO_BUILD_REIMBURSEMENT_TRACKING_UI ?? "no");
  if (previewReady !== "yes" || safeUi !== "yes") {
    throw new Error(
      `BLOCKED: preview gates must be yes (preview=${previewReady}, ui=${safeUi})`,
    );
  }

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const linesBefore = (
    await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const candidatesBefore = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsBefore = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const composed = await composeReimbursementTrackingPreviewV1(client, ORG, STORE);
  const payload = buildReimbursementTrackingUiPayload({
    pilot_case_run_id: composed.pilot_case_run_id,
    intake_run_id: composed.intake_run_id,
    previews: composed.previews,
    legacy_visibility: composed.legacy_visibility,
    preview_run_reference: "phase-claim-reimbursement-tracking-preview-v1/20260617T130000Z",
  });

  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const linesAfter = (
    await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const candidatesAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsAfter = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const scannerAfter = scannerGitStatus();

  const view = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx");
  const drawer = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx");
  const table = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx");
  const disabled = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingDisabledActions.tsx");
  const navConfig = read("components/claim-center/claim-center-nav-config.ts");

  const shipmentRow = payload.previews.find((p) => p.family_key_v3 === "removal_shipment_missing");
  const orderRow = payload.previews.find((p) => p.family_key_v3 === "removal_order_discrepancy");

  const moneyNullPass = payload.previews.every(
    (p) => p.estimated_amount == null && p.recovery_value == null && p.observed_reimbursement == null,
  );

  const previewCount = Number(preview.pilot_submission_count ?? 0);
  const summaryMatch =
    payload.summary_cards.pilot_submission_count === previewCount &&
    payload.summary_cards.pilot_submission_count === 10;

  const filterVerify = verifyFiltersSearch(payload.previews);

  const routeOrTab = {
    route: "/claim-center/reimbursement-tracking",
    financial_nav_tabs: CLAIM_CENTER_FINANCIAL_NAV.map((n) => n.label),
    pool_nav_link: navConfig.includes("/claim-center/reimbursement-tracking"),
  };

  const pageLayoutSummary = {
    header: view.includes("ReimbursementTrackingHeader"),
    summary_cards: view.includes("ReimbursementTrackingSummaryCards"),
    workflow_strip: view.includes("ReimbursementTrackingWorkflowStrip"),
    filters: view.includes("ReimbursementTrackingFilters"),
    table: view.includes("ReimbursementTrackingTable"),
    drawer: view.includes("ReimbursementTrackingDetailDrawer"),
    disabled_actions: view.includes("ReimbursementTrackingDisabledActions"),
    empty_states: view.includes("No pilot submission records found"),
  };

  const noDbWrite =
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candidatesAfter === candidatesBefore &&
    submissionsAfter === submissionsBefore;

  const structuralPass =
    payload.previews.length === 10 &&
    payload.legacy_visibility.excluded_from_pilot_preview === true &&
    payload.legacy_visibility.count === 3 &&
    summaryMatch &&
    moneyNullPass &&
    filterVerify.pass &&
    noDbWrite &&
    shipmentRow != null &&
    orderRow != null;

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-claim-reimbursement-tracking-ui-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const uiPass = structuralPass && buildResult === "pass" && smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-V1",
    version: REIMBURSEMENT_TRACKING_UI_VERSION,
    run_id: id,
    mode: "read-only",
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    prerequisite_status: {
      preview_evidence_path: PREVIEW_RESULTS,
      SAFE_REIMBURSEMENT_TRACKING_PREVIEW_READY: previewReady,
      SAFE_TO_BUILD_REIMBURSEMENT_TRACKING_UI: safeUi,
      pass: previewReady === "yes" && safeUi === "yes",
    },
    files_changed: FILES_CHANGED.filter((f) => fileExists(f)),
    route_or_tab_added: routeOrTab,
    page_layout_summary: pageLayoutSummary,
    summary_cards_verification: {
      pass: summaryMatch,
      api: payload.summary_cards,
      preview_pilot_count: previewCount,
    },
    workflow_strip_verification: {
      pass: view.includes("ReimbursementTrackingWorkflowStrip"),
      counts: payload.workflow_counts,
    },
    table_columns_verification: {
      pass:
        table.includes("Est. recoverable") &&
        table.includes("Observed") &&
        table.includes("Open gap") &&
        table.includes("Unknown"),
      column_headers: [
        "Status",
        "Family",
        "Case",
        "Submission",
        "Product",
        "Source / tracking",
        "Qty",
        "Est. recoverable",
        "Observed",
        "Open gap",
        "Match",
        "Next action",
      ],
    },
    filters_search_verification: filterVerify,
    detail_drawer_verification: {
      pass:
        drawer.includes("A. Claim summary") &&
        drawer.includes("B. Product identity") &&
        drawer.includes("C. Reference graph") &&
        drawer.includes("D. Financial breakdown") &&
        drawer.includes("E. Reimbursement match") &&
        drawer.includes("F. Filing packet / evidence") &&
        drawer.includes("G. Next action") &&
        drawer.includes("Raw details"),
      sample_shipment_case_id: shipmentRow?.claim_case_id ?? null,
      sample_order_case_id: orderRow?.claim_case_id ?? null,
    },
    reference_graph_ui_verification: {
      pass: drawer.includes("Reference graph present") && shipmentRow != null,
      shipment_graph_lines: shipmentRow?.detail_preview.reference_graph_lines.length ?? 0,
      order_graph_lines: orderRow?.detail_preview.reference_graph_lines.length ?? 0,
    },
    money_null_display_verification: {
      pass: moneyNullPass && table.includes("Unknown") && !table.includes('?? "$0"'),
      coerced_non_null: payload.previews.filter(
        (p) => p.estimated_amount === 0 && p.recovery_value == null,
      ).length,
    },
    empty_states_verification: {
      pass:
        view.includes("No pilot submission records found") &&
        view.includes("No reimbursement matched yet") &&
        view.includes("Money lanes are incomplete") &&
        table.includes("No results match these filters"),
    },
    legacy_submission_visibility_verification: {
      pass: payload.legacy_visibility.count === 3 && payload.legacy_visibility.excluded_from_pilot_preview,
      legacy: payload.legacy_visibility,
      pilot_rows_in_api: payload.previews.length,
    },
    disabled_actions_verification: {
      pass:
        disabled.includes("disabled") &&
        disabled.includes("REIMBURSEMENT_TRACKING_READ_ONLY_TOOLTIP") &&
        !view.includes(".insert("),
      actions: ["Submit to Amazon", "Mark reimbursed", "Edit submission", "Close case", "Upload evidence"],
    },
    before_snapshot: {
      claim_cases: casesBefore,
      claim_lines: linesBefore,
      claim_candidates: candidatesBefore,
      claim_submissions: submissionsBefore,
    },
    after_snapshot: {
      claim_cases: casesAfter,
      claim_lines: linesAfter,
      claim_candidates: candidatesAfter,
      claim_submissions: submissionsAfter,
    },
    no_db_write_verification: { pass: noDbWrite },
    no_claim_submission_mutation_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged_count: submissionsBefore,
    },
    no_amazon_submission_verification: {
      pass: !view.includes("amazon-sp-api") && payload.not_submitted_to_amazon === true,
    },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    pilot_submission_count: payload.previews.length,
    family_distribution: payload.family_split,
    structural_pass: structuralPass,
    ui_pass: uiPass,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_REIMBURSEMENT_TRACKING_UI_READY: uiPass ? "yes" : "no",
    SAFE_TO_REVIEW_FINANCIAL_TRACKING_UI: uiPass ? "yes" : "no",
    SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY: uiPass ? "yes" : "no",
    NEXT_PROMPT: uiPass
      ? "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-PLAN-V1 — operator status entry contract (no Amazon submit)"
      : "PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-V1 — remediate structural or build/smoke failures",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Reimbursement tracking UI V1

**Run:** ${id} · **Ref:** ${ref} · **Route:** /claim-center/reimbursement-tracking

- Pilot rows: **${payload.previews.length}** / **10**
- Summary cards match preview: **${summaryMatch ? "yes" : "no"}**
- SAFE_REIMBURSEMENT_TRACKING_UI_READY: **${results.SAFE_REIMBURSEMENT_TRACKING_UI_READY}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (results.SAFE_REIMBURSEMENT_TRACKING_UI_READY !== "yes") {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
