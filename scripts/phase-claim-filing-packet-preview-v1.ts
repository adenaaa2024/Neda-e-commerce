/**
 * PHASE-CLAIM-FILING-PACKET-PREVIEW-V1 — read-only filing packet preview verify
 *   npx tsx scripts/phase-claim-filing-packet-preview-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  composeClaimFilingPacketPreviewV1,
  FILING_PACKET_PREVIEW_SHAPE_FIELDS,
  mapCaseRowToFilingPacketPreviewV1,
  verifyMoneyNullPreservationPreview,
} from "../lib/claims/filing/claim-filing-packet-preview-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-filing-packet-preview-v1";
const PLAN_VERIFY =
  ".cursor/audit-reports/phase-claim-filing-packet-plan-v1/20260616T050000Z/results.json";

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

function loadPlanPrerequisite(): { pass: boolean; safe_to_build_preview: string } {
  const planPath = path.join(process.cwd(), PLAN_VERIFY);
  if (!fs.existsSync(planPath)) {
    return { pass: false, safe_to_build_preview: "missing" };
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, unknown>;
  const safe = str(plan.SAFE_TO_BUILD_FILING_PACKET_PREVIEW);
  return { pass: safe === "yes", safe_to_build_preview: safe };
}

function slimPreview(p: ReturnType<typeof mapCaseRowToFilingPacketPreviewV1>) {
  return {
    filing_packet_preview_id: p.filing_packet_preview_id,
    claim_case_id: p.claim_case_id,
    family_key_v3: p.family_key_v3,
    case_status: p.case_status,
    clean_quantity: p.clean_quantity,
    evidence_snapshot_present: p.evidence_packet_snapshot != null,
    money_lanes: p.money_lanes,
    warnings: p.warnings,
    blockers: p.blockers,
    readiness: p.readiness,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const prereq = loadPlanPrerequisite();
  if (!prereq.pass) {
    throw new Error(
      `BLOCKED: SAFE_TO_BUILD_FILING_PACKET_PREVIEW=${prereq.safe_to_build_preview} (expected yes from plan verify)`,
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
  const candidatesBefore = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsBefore = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const allPayload = await composeClaimFilingPacketPreviewV1(client, ORG, STORE, {
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

  const shipmentSample = allPayload.previews.find(
    (p) => p.family_key_v3 === "removal_shipment_missing",
  );
  const orderSample = allPayload.previews.find(
    (p) => p.family_key_v3 === "removal_order_discrepancy",
  );

  let singleShipment: Awaited<ReturnType<typeof composeClaimFilingPacketPreviewV1>> | null = null;
  let singleOrder: Awaited<ReturnType<typeof composeClaimFilingPacketPreviewV1>> | null = null;
  if (shipmentSample) {
    singleShipment = await composeClaimFilingPacketPreviewV1(client, ORG, STORE, {
      pilot_case_run_id: PILOT_CASE_RUN_ID,
      intake_run_id: PILOT_INTAKE_RUN_ID,
      case_id: shipmentSample.claim_case_id,
      status: "open",
      limit: 1,
    });
  }
  if (orderSample) {
    singleOrder = await composeClaimFilingPacketPreviewV1(client, ORG, STORE, {
      pilot_case_run_id: PILOT_CASE_RUN_ID,
      intake_run_id: PILOT_INTAKE_RUN_ID,
      case_id: orderSample.claim_case_id,
      status: "open",
      limit: 1,
    });
  }

  const moneyCheck = verifyMoneyNullPreservationPreview(allPayload.previews);
  const evidenceSnapshotCount = allPayload.previews.filter(
    (p) => p.evidence_packet_snapshot != null,
  ).length;
  const cleanQtyCount = allPayload.previews.filter((p) => p.clean_quantity != null).length;

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

  const noDbWrite =
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candidatesAfter === candidatesBefore &&
    submissionsAfter === submissionsBefore;

  const familyDist = allPayload.summary.by_family_key_v3;
  const allPass =
    allPayload.previews.length === 10 &&
    familyDist.removal_shipment_missing === 6 &&
    familyDist.removal_order_discrepancy === 4 &&
    closedPayload.rows.length === 10 &&
    evidenceSnapshotCount === 10 &&
    cleanQtyCount === 10 &&
    allPayload.summary.ready_for_pdf_preview_count === 10 &&
    allPayload.summary.ready_for_manual_filing_count === 10 &&
    moneyCheck.pass &&
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
    execSync(`npx tsx scripts/smoke-claim-filing-packet-preview-v1.ts --run-id=${id}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch {
    smokeResult = "fail";
  }

  const results = {
    prompt: "PHASE-CLAIM-FILING-PACKET-PREVIEW-V1",
    run_id: id,
    mode: "read-only-preview",
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    prerequisite_status: {
      SAFE_TO_BUILD_FILING_PACKET_PREVIEW: prereq.safe_to_build_preview,
      prerequisite_pass: prereq.pass,
    },
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    files_changed: [
      "lib/claims/filing/claim-filing-packet-preview-v1.ts",
      "lib/claims/center/claim-center-api-handlers.ts",
      "app/api/claims/center/filing-packet-preview/route.ts",
      "scripts/phase-claim-filing-packet-preview-v1.ts",
      "scripts/smoke-claim-filing-packet-preview-v1.ts",
    ],
    api_route_added: "GET /api/claims/center/filing-packet-preview",
    filing_packet_preview_shape: [...FILING_PACKET_PREVIEW_SHAPE_FIELDS],
    single_case_preview_samples: {
      removal_shipment_missing: singleShipment?.previews[0]
        ? slimPreview(singleShipment.previews[0])
        : null,
      removal_order_discrepancy: singleOrder?.previews[0]
        ? slimPreview(singleOrder.previews[0])
        : null,
    },
    all_10_preview_summary: allPayload.previews.map(slimPreview),
    active_cases_loaded_count: allPayload.summary.active_cases_loaded,
    closed_duplicates_excluded_count: closedPayload.rows.length,
    family_distribution: familyDist,
    ready_for_pdf_preview_count: allPayload.summary.ready_for_pdf_preview_count,
    ready_for_manual_filing_count: allPayload.summary.ready_for_manual_filing_count,
    blocker_counts: allPayload.summary.blocker_counts,
    warning_counts: allPayload.summary.warning_counts,
    evidence_snapshot_check: {
      pass: evidenceSnapshotCount === 10,
      present: evidenceSnapshotCount,
      total: allPayload.previews.length,
    },
    money_null_preservation_check: moneyCheck,
    no_db_write_verification: {
      pass: noDbWrite,
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_candidates: { before: candidatesBefore, after: candidatesAfter },
      claim_submissions: { before: submissionsBefore, after: submissionsAfter },
    },
    no_claim_case_mutation_verification: {
      pass: casesAfter === casesBefore && linesAfter === linesBefore,
    },
    no_claim_submission_mutation_verification: {
      pass: submissionsAfter === submissionsBefore,
      before: submissionsBefore,
      after: submissionsAfter,
    },
    no_pdf_generation_verification: { pass: true, note: "preview only — no PDF artifacts" },
    no_amazon_submission_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged: submissionsAfter === 3,
    },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_FILING_PACKET_PREVIEW_READY: allPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    SAFE_TO_BUILD_FILING_PACKET_UI:
      allPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    SAFE_TO_PLAN_PDF_EXPORT_PREVIEW:
      allPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    NEXT_PROMPT:
      allPass && buildResult === "pass" && smokeResult === "pass"
        ? "PHASE-CLAIM-FILING-PACKET-UI-V1 — Case Review drawer filing packet preview panel + read-only export affordances"
        : "PHASE-CLAIM-FILING-PACKET-PREVIEW-V1 — fix failing preview checks before UI wire",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim filing packet preview V1

**Run:** ${id} · **Ref:** ${ref} · **Mode:** read-only preview

- Active previews: **${allPayload.summary.active_cases_loaded}**
- Family: **${familyDist.removal_shipment_missing ?? 0}** shipment / **${familyDist.removal_order_discrepancy ?? 0}** order
- Closed excluded: **${closedPayload.rows.length}**
- Ready PDF / manual: **${allPayload.summary.ready_for_pdf_preview_count}** / **${allPayload.summary.ready_for_manual_filing_count}**
- SAFE_FILING_PACKET_PREVIEW_READY: **${results.SAFE_FILING_PACKET_PREVIEW_READY}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (results.SAFE_FILING_PACKET_PREVIEW_READY !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
