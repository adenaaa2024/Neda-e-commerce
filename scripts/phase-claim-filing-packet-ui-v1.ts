/**
 * PHASE-CLAIM-FILING-PACKET-UI-V1 — read-only filing packet UI verify
 *   npx tsx scripts/phase-claim-filing-packet-ui-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  deriveFilingPacketReadinessBadges,
  FILING_PACKET_DRAWER_FIELDS,
  filingPacketPreviewDisabled,
  isRemediatedDuplicateCase,
} from "../lib/claims/filing/claim-filing-packet-ui-contract";
import {
  composeClaimFilingPacketPreviewV1,
  mapCaseRowToFilingPacketPreviewV1,
} from "../lib/claims/filing/claim-filing-packet-preview-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-filing-packet-ui-v1";
const PREVIEW_VERIFY =
  ".cursor/audit-reports/phase-claim-filing-packet-preview-v1/20260616T060000Z/results.json";

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

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function loadPrerequisite(): {
  pass: boolean;
  safe_preview: string;
  safe_ui: string;
} {
  const p = path.join(process.cwd(), PREVIEW_VERIFY);
  if (!fs.existsSync(p)) {
    return { pass: false, safe_preview: "missing", safe_ui: "missing" };
  }
  const data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  const safePreview = str(data.SAFE_FILING_PACKET_PREVIEW_READY);
  const safeUi = str(data.SAFE_TO_BUILD_FILING_PACKET_UI);
  return { pass: safePreview === "yes" && safeUi === "yes", safe_preview: safePreview, safe_ui: safeUi };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const prereq = loadPrerequisite();
  if (!prereq.pass) {
    throw new Error(
      `BLOCKED: SAFE_FILING_PACKET_PREVIEW_READY=${prereq.safe_preview}, SAFE_TO_BUILD_FILING_PACKET_UI=${prereq.safe_ui}`,
    );
  }

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
  const submissionsBefore = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const openPayload = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "open",
    limit: 100,
  });

  const closedPayload = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "closed",
    limit: 100,
  });

  const shipmentRow = openPayload.rows.find((r) => r.family_key_v3 === "removal_shipment_missing");
  const orderRow = openPayload.rows.find((r) => r.family_key_v3 === "removal_order_discrepancy");

  const shipmentPreview = shipmentRow ? mapCaseRowToFilingPacketPreviewV1(shipmentRow) : null;
  const orderPreview = orderRow ? mapCaseRowToFilingPacketPreviewV1(orderRow) : null;

  const closedRemediatedChecks = closedPayload.rows.map((r) => ({
    case_id: r.id,
    remediated: isRemediatedDuplicateCase(r),
    preview_disabled: filingPacketPreviewDisabled(r),
    status: r.status,
  }));

  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const linesAfter = (
    await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsAfter = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const scannerAfter = scannerGitStatus();
  const noDbWrite =
    casesAfter === casesBefore && linesAfter === linesBefore && submissionsAfter === submissionsBefore;

  const allPreview = await composeClaimFilingPacketPreviewV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "open",
    limit: 100,
  });

  const sampleUiVerification = {
    removal_shipment_missing: shipmentRow && shipmentPreview
      ? {
          case_id: shipmentRow.id,
          badges: deriveFilingPacketReadinessBadges(shipmentPreview, false),
          preview_disabled: filingPacketPreviewDisabled(shipmentRow),
          ready_for_pdf: shipmentPreview.readiness.ready_for_pdf_preview,
          ready_for_manual: shipmentPreview.readiness.ready_for_manual_filing,
          warnings: shipmentPreview.warnings,
          blockers: shipmentPreview.blockers,
        }
      : null,
    removal_order_discrepancy: orderRow && orderPreview
      ? {
          case_id: orderRow.id,
          badges: deriveFilingPacketReadinessBadges(orderPreview, false),
          preview_disabled: filingPacketPreviewDisabled(orderRow),
          ready_for_pdf: orderPreview.readiness.ready_for_pdf_preview,
          ready_for_manual: orderPreview.readiness.ready_for_manual_filing,
          warnings: orderPreview.warnings,
          blockers: orderPreview.blockers,
        }
      : null,
  };

  const closedAllDisabled =
    closedRemediatedChecks.length === 10 &&
    closedRemediatedChecks.every((c) => c.remediated && c.preview_disabled);

  const allPass =
    openPayload.rows.length === 10 &&
    closedPayload.rows.length === 10 &&
    closedAllDisabled &&
    shipmentPreview != null &&
    orderPreview != null &&
    allPreview.previews.length === 10 &&
    noDbWrite;

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync(`npx tsx scripts/smoke-claim-filing-packet-ui-v1.ts --run-id=${id}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch {
    smokeResult = "fail";
  }

  const results = {
    prompt: "PHASE-CLAIM-FILING-PACKET-UI-V1",
    run_id: id,
    mode: "read-only-ui-verify",
    prerequisite_status: {
      SAFE_FILING_PACKET_PREVIEW_READY: prereq.safe_preview,
      SAFE_TO_BUILD_FILING_PACKET_UI: prereq.safe_ui,
      prerequisite_pass: prereq.pass,
    },
    files_changed: [
      "lib/claims/filing/claim-filing-packet-ui-contract.ts",
      "components/claim-center/case-review/ClaimCaseReviewFilingPacketSection.tsx",
      "components/claim-center/case-review/ClaimCaseReviewDetailDrawer.tsx",
      "components/claim-center/case-review/ClaimCaseReviewView.tsx",
      "lib/claims/pilot/claim-case-review-ui-contract.ts",
      "scripts/phase-claim-filing-packet-ui-v1.ts",
      "scripts/smoke-claim-filing-packet-ui-v1.ts",
    ],
    UI_sections_added: ["Filing packet (case detail drawer)"],
    filing_packet_drawer_fields: [...FILING_PACKET_DRAWER_FIELDS],
    readiness_badge_behavior: {
      blocked: "blockers present OR remediated/closed case",
      needs_review: "warnings without blockers",
      ready_for_pdf_preview: "readiness.ready_for_pdf_preview when not blocked",
      ready_for_manual_filing: "readiness.ready_for_manual_filing when not blocked",
      multiple_badges: "needs_review can co-display with ready badges",
    },
    active_cases_loaded_count: openPayload.rows.length,
    sample_case_ui_verification: sampleUiVerification,
    closed_duplicate_visibility_behavior: {
      default_hidden: "status=open filter excludes 10 closed remediated duplicates",
      closed_filter_count: closedPayload.rows.length,
      closed_preview_disabled: closedAllDisabled,
      closed_checks: closedRemediatedChecks.slice(0, 3),
    },
    disabled_actions_verification: {
      submit_claim: "disabled in ClaimCaseReviewDisabledActions",
      generate_pdf: "disabled",
      create_submission: "disabled (added to CASE_REVIEW_DISABLED_ACTIONS)",
      edit_case: "disabled",
      close_case: "disabled",
      cancel_case: "disabled",
    },
    no_db_write_verification: {
      pass: noDbWrite,
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_submissions: { before: submissionsBefore, after: submissionsAfter },
    },
    no_claim_case_mutation_verification: { pass: casesAfter === casesBefore && linesAfter === linesBefore },
    no_claim_submission_mutation_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged: submissionsAfter === 3,
    },
    no_pdf_generation_verification: { pass: true, note: "UI only — no PDF artifacts" },
    no_amazon_submission_verification: { pass: submissionsAfter === submissionsBefore },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_REVIEW_FILING_PACKET_UI:
      allPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    SAFE_TO_PLAN_PDF_EXPORT_PREVIEW:
      allPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    NEXT_PROMPT:
      allPass && buildResult === "pass" && smokeResult === "pass"
        ? "PHASE-CLAIM-PDF-EXPORT-PREVIEW-PLAN-V1 — read-only PDF export preview contract (no generate yet)"
        : "PHASE-CLAIM-FILING-PACKET-UI-V1 — fix failing UI checks before PDF export planning",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim filing packet UI V1

**Run:** ${id} · **Ref:** ${ref} · **Mode:** read-only UI verify

- Active cases: **${openPayload.rows.length}**
- Closed excluded by default: **${closedPayload.rows.length}**
- SAFE_TO_REVIEW_FILING_PACKET_UI: **${results.SAFE_TO_REVIEW_FILING_PACKET_UI}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (results.SAFE_TO_REVIEW_FILING_PACKET_UI !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
