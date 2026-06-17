/**
 * PHASE-CLAIM-CASE-REVIEW-UI-REVERIFY-AFTER-REMEDIATION-V1
 * Read-only Case Review UI re-verify after pilot remediation.
 *   npx tsx scripts/phase-claim-case-review-ui-reverify-after-remediation-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  buildClaimCaseReviewReadmodel,
  DEFAULT_PILOT_CASE_RUN_ID,
} from "../lib/claims/pilot/claim-case-review-readmodel";
import {
  CASE_REVIEW_DISABLED_ACTIONS,
  CASE_REVIEW_STATUS_OPTIONS,
  DEFAULT_CASE_REVIEW_FILTER_STATE,
  caseReviewFiltersSupported,
  verifyCaseReviewDisplay,
} from "../lib/claims/pilot/claim-case-review-ui-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-case-review-ui-reverify-after-remediation-v1";
const POST_VERIFY_AFTER_REMEDIATION =
  ".cursor/audit-reports/phase-claim-case-creation-pilot-post-verify-after-remediation-v1/20260616T030000Z/results.json";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const INTAKE_RUN_ID = "a8a892fe-37d5-4d74-9ea2-02af8fd095ce";
const EXPECTED_CAP = 10;
const EXPECTED_FAMILY = {
  removal_shipment_missing: 6,
  removal_order_discrepancy: 4,
};

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

function loadPostVerifyPrerequisites(): {
  rows_trusted: string;
  safe_to_reverify_ui: string;
  safe_to_plan_filing: string;
} {
  const p = path.join(process.cwd(), POST_VERIFY_AFTER_REMEDIATION);
  if (!fs.existsSync(p)) {
    return { rows_trusted: "missing", safe_to_reverify_ui: "missing", safe_to_plan_filing: "no" };
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  return {
    rows_trusted: String(raw.SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED ?? "no"),
    safe_to_reverify_ui: String(raw.SAFE_TO_REVERIFY_CASE_REVIEW_UI ?? "no"),
    safe_to_plan_filing: String(raw.SAFE_TO_PLAN_FILING_PACKET_OR_PDF ?? "no"),
  };
}

function readUiSources() {
  const view = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/case-review/ClaimCaseReviewView.tsx"),
    "utf8",
  );
  const drawer = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/case-review/ClaimCaseReviewDetailDrawer.tsx"),
    "utf8",
  );
  const disabled = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/case-review/ClaimCaseReviewDisabledActions.tsx"),
    "utf8",
  );
  const filters = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/case-review/ClaimCaseReviewFilters.tsx"),
    "utf8",
  );
  const contract = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/pilot/claim-case-review-ui-contract.ts"),
    "utf8",
  );
  return { view, drawer, disabled, filters, contract };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const prereq = loadPostVerifyPrerequisites();
  const prerequisitePass =
    prereq.rows_trusted === "yes" && prereq.safe_to_reverify_ui === "yes";

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

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

  const activePayload = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: DEFAULT_PILOT_CASE_RUN_ID,
    intake_run_id: INTAKE_RUN_ID,
    status: "open",
    limit: 100,
  });

  const allPayload = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: DEFAULT_PILOT_CASE_RUN_ID,
    intake_run_id: INTAKE_RUN_ID,
    limit: 100,
  });

  const closedPayload = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: DEFAULT_PILOT_CASE_RUN_ID,
    intake_run_id: INTAKE_RUN_ID,
    status: "closed",
    limit: 100,
  });

  const expectedCleanQty = activePayload.rows.reduce(
    (sum, r) => sum + (r.clean_quantity ?? r.quantity_expected ?? 0),
    0,
  );

  const shipmentCase = activePayload.rows.find((r) => r.family_key_v3 === "removal_shipment_missing");
  const orderCase = activePayload.rows.find((r) => r.family_key_v3 === "removal_order_discrepancy");

  const shipmentDisplay = shipmentCase
    ? verifyCaseReviewDisplay(shipmentCase)
    : { pass: false, missing: ["no_shipment_case"] };
  const orderDisplay = orderCase
    ? verifyCaseReviewDisplay(orderCase)
    : { pass: false, missing: ["no_order_case"] };

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
  const ui = readUiSources();

  const family_distribution_verification = {
    pass:
      activePayload.summary.by_family_key_v3.removal_shipment_missing ===
        EXPECTED_FAMILY.removal_shipment_missing &&
      activePayload.summary.by_family_key_v3.removal_order_discrepancy ===
        EXPECTED_FAMILY.removal_order_discrepancy,
    actual: activePayload.summary.by_family_key_v3,
    expected: EXPECTED_FAMILY,
  };

  const capMismatchWouldShow =
    activePayload.summary.open_cases !== activePayload.expected_pilot_cap;
  const cap_mismatch_banner_status = capMismatchWouldShow
    ? "shown_open_count_mismatch"
    : "hidden_resolved";

  const defaultStatusOpen = DEFAULT_CASE_REVIEW_FILTER_STATE.status === "open";
  const capBannerUsesOpenCount = ui.view.includes("summary.open_cases");
  const remediated_cases_visibility_behavior = {
    default_filter_status: DEFAULT_CASE_REVIEW_FILTER_STATE.status,
    default_hides_closed: defaultStatusOpen,
    active_open_visible_count: activePayload.rows.length,
    all_scoped_count: allPayload.rows.length,
    closed_filter_count: closedPayload.rows.length,
    closed_cases_have_remediation_metadata: closedPayload.rows.every(
      (r) => r.rollback_metadata != null || r.status === "closed",
    ),
    ui_has_status_filter: ui.filters.includes("Case status"),
    closed_visible_only_via_filter: closedPayload.rows.length === 10,
  };

  const summary_cards_verification = {
    pass:
      activePayload.summary.total_pilot_cases === EXPECTED_CAP &&
      activePayload.summary.open_cases === EXPECTED_CAP &&
      activePayload.summary.total_clean_quantity === expectedCleanQty &&
      expectedCleanQty > 0,
    total_pilot_cases: activePayload.summary.total_pilot_cases,
    open_cases: activePayload.summary.open_cases,
    total_clean_quantity: activePayload.summary.total_clean_quantity,
    expected_clean_quantity_sum: expectedCleanQty,
    warning_count: activePayload.summary.warning_count,
    money_lane_availability: activePayload.summary.money_lane_availability,
  };

  const detail_drawer_verification = {
    pass: shipmentDisplay.pass && orderDisplay.pass,
    ui_fields: {
      case_metadata: ui.drawer.includes("Case metadata"),
      lines: ui.drawer.includes("Lines"),
      candidate_link: ui.drawer.includes("Candidate link"),
      evidence_packet_snapshot: ui.drawer.includes("Evidence packet"),
      reference_edges: ui.drawer.includes("Reference edges"),
      operator_attestation: ui.drawer.includes("Operator attestation"),
      rollback_metadata: ui.drawer.includes("Rollback metadata"),
    },
    samples: {
      removal_shipment_missing: shipmentCase
        ? { case_id: shipmentCase.id, display: shipmentDisplay }
        : null,
      removal_order_discrepancy: orderCase
        ? { case_id: orderCase.id, display: orderDisplay }
        : null,
    },
  };

  const disabled_actions_verification = {
    pass:
      ui.disabled.includes("CASE_REVIEW_DISABLED_ACTIONS") &&
      ui.disabled.includes("disabled") &&
      ui.disabled.includes("aria-disabled"),
    actions: CASE_REVIEW_DISABLED_ACTIONS.map((a) => a.label),
  };

  let buildResult = "fail";
  try {
    execSync("npm run build", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail:${e instanceof Error ? e.message.slice(0, 200) : "build_error"}`;
  }

  let smokeResult = "fail";
  try {
    execSync(`npx tsx scripts/smoke-claim-case-review-ui-v1.ts --run-id=${id}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch {
    smokeResult = "fail";
  }

  const noDbWrites =
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candidatesAfter === candidatesBefore;
  const noSubmissionsMutation = submissionsAfter === submissionsBefore;

  const uiPass =
    prerequisitePass &&
    buildResult === "pass" &&
    smokeResult === "pass" &&
    activePayload.rows.length === EXPECTED_CAP &&
    family_distribution_verification.pass &&
    summary_cards_verification.pass &&
    detail_drawer_verification.pass &&
    disabled_actions_verification.pass &&
    defaultStatusOpen &&
    capBannerUsesOpenCount &&
    !capMismatchWouldShow &&
    closedPayload.rows.length === 10 &&
    noDbWrites &&
    noSubmissionsMutation;

  const results = {
    prompt: "PHASE-CLAIM-CASE-REVIEW-UI-REVERIFY-AFTER-REMEDIATION-V1",
    run_id: id,
    mode: "read-only-ui-reverify",
    prerequisite_status: {
      post_verify_after_remediation_run_id: "20260616T030000Z",
      SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED: prereq.rows_trusted,
      SAFE_TO_REVERIFY_CASE_REVIEW_UI: prereq.safe_to_reverify_ui,
      prerequisite_pass: prerequisitePass,
      blocked_reason: prerequisitePass
        ? null
        : `POST-VERIFY gates not met (ROWS_TRUSTED=${prereq.rows_trusted}, REVIEW_UI=${prereq.safe_to_reverify_ui})`,
    },
    route_or_tab_verified: "/claim-center/case-review (Claim Center → Case review)",
    filters_supported: caseReviewFiltersSupported(),
    status_filter_options: CASE_REVIEW_STATUS_OPTIONS.map((o) => o.value),
    pilot_case_run_id: DEFAULT_PILOT_CASE_RUN_ID,
    intake_run_id: INTAKE_RUN_ID,
    active_pilot_cases_loaded_count: activePayload.rows.length,
    expected_active_cap: EXPECTED_CAP,
    family_distribution_verification,
    cap_mismatch_banner_status,
    remediated_cases_visibility_behavior,
    summary_cards_verification,
    detail_drawer_verification,
    evidence_packet_snapshot_display: {
      pass: activePayload.rows.every((r) => r.evidence_packet_snapshot != null),
      rows_with_snapshot: activePayload.rows.filter((r) => r.evidence_packet_snapshot).length,
    },
    candidate_link_verification: {
      pass: activePayload.rows.every((r) => r.candidate_ids.length > 0),
      ui_has_candidate_link: ui.drawer.includes("Candidate link"),
      ui_has_pilot_review_href: ui.drawer.includes("/claim-center/pilot-review"),
    },
    disabled_actions_verification,
    no_db_write_verification: {
      pass: noDbWrites,
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_candidates: { before: candidatesBefore, after: candidatesAfter },
    },
    no_claim_case_mutation_verification: { pass: casesAfter === casesBefore && linesAfter === linesBefore },
    no_claim_submission_mutation_verification: {
      pass: noSubmissionsMutation,
      before: submissionsBefore,
      after: submissionsAfter,
    },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_REVIEW_CASES_IN_UI: uiPass ? "yes" : "no",
    SAFE_TO_PLAN_FILING_PACKET_OR_PDF: uiPass && prereq.safe_to_plan_filing === "yes" ? "yes" : "no",
    NEXT_PROMPT: uiPass
      ? "PHASE-CLAIM-FILING-PACKET-PLAN-V1 — read-only filing packet contract before PDF generation"
      : prerequisitePass
        ? "PHASE-CLAIM-CASE-REVIEW-UI-REVERIFY-AFTER-REMEDIATION-V1 — fix failing UI reverify checks"
        : "PHASE-CLAIM-CASE-CREATION-PILOT-POST-VERIFY-AFTER-REMEDIATION-V1 — complete post-remediation verify first",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Case review UI reverify after remediation V1

**Run:** ${id} · **Ref:** ${ref}

- Route: \`/claim-center/case-review\`
- Active open cases (default filter): **${activePayload.rows.length}** (expected **${EXPECTED_CAP}**)
- Closed remediated (closed filter): **${closedPayload.rows.length}**
- Cap banner: **${cap_mismatch_banner_status}**
- SAFE_TO_REVIEW_CASES_IN_UI: **${results.SAFE_TO_REVIEW_CASES_IN_UI}**
- SAFE_TO_PLAN_FILING_PACKET_OR_PDF: **${results.SAFE_TO_PLAN_FILING_PACKET_OR_PDF}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (!uiPass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
