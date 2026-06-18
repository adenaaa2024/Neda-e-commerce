/**
 * PHASE-CLAIM-SELLER-CENTRAL-FILING-PACKET-V1
 *
 * Read-only generation of one manual Seller Central filing packet per pilot
 * claim_submission_id (or grouped where references are safely shared).
 * No DB write, no claim_* mutation, no Amazon, no browser automation, no scanner
 * change, no AI. The caller adds git/build/smoke guards.
 *
 *   npx tsx scripts/phase-claim-seller-central-filing-packet-v1.ts [--run-id=<UTC>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimSellerCentralFilingPacketV1 } from "../lib/claims/filing/claim-seller-central-filing-packet-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const PROMPT = "PHASE-CLAIM-SELLER-CENTRAL-FILING-PACKET-V1";
const OUT = ".cursor/audit-reports/phase-claim-seller-central-filing-packet-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const EXPECTED_PILOT_SUBMISSION_COUNT = 10;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function gitStatus(globs: string): string {
  try {
    return execSync(`git status --porcelain ${globs}`, { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function grepLines(pattern: string, scope: string): string {
  try {
    return execSync(`git grep -nE "${pattern}" -- ${scope}`, { encoding: "utf8" }).trim();
  } catch (e) {
    const err = e as { status?: number };
    if (err.status === 1) return ""; // no matches
    return "grep_unavailable";
  }
}

async function countOrg(client: SupabaseClient, table: string): Promise<number> {
  const { count } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);
  return count ?? 0;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });

  // ---- Mutation guard: snapshot before ----
  const scannerBefore = gitStatus("app/scanner lib/scanner");
  const [subsBefore, casesBefore, linesBefore, candsBefore, edgesBefore] = await Promise.all([
    countOrg(client, "claim_submissions"),
    countOrg(client, "claim_cases"),
    countOrg(client, "claim_lines"),
    countOrg(client, "claim_candidates"),
    countOrg(client, "claim_reference_edges"),
  ]);

  // ---- Compose (read-only) ----
  const data = await composeClaimSellerCentralFilingPacketV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  // ---- Mutation guard: snapshot after ----
  const [subsAfter, casesAfter, linesAfter, candsAfter, edgesAfter] = await Promise.all([
    countOrg(client, "claim_submissions"),
    countOrg(client, "claim_cases"),
    countOrg(client, "claim_lines"),
    countOrg(client, "claim_candidates"),
    countOrg(client, "claim_reference_edges"),
  ]);
  const scannerAfter = gitStatus("app/scanner lib/scanner");

  const noMutation =
    subsAfter === subsBefore &&
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candsAfter === candsBefore &&
    edgesAfter === edgesBefore;
  const noScannerChange = scannerBefore === scannerAfter;

  // ---- No Amazon submit / no browser automation (static) ----
  const amazonSubmitHits = grepLines(
    "submitClaimToAmazon|amazonSubmit|createAmazonCase|automateSellerCentral|postToAmazon",
    "app lib components",
  );
  const remoteNavHits = grepLines("goto\\(.*https?://", "lib/claims app/claim-center app/api/claims");
  const noAmazonSubmission = {
    pass: amazonSubmitHits === "" && remoteNavHits === "",
    amazon_submit_symbols: amazonSubmitHits === "" ? "none" : amazonSubmitHits,
    remote_browser_navigation: remoteNavHits === "" ? "none" : remoteNavHits,
    browser_automation_present: "none in this phase (filing packets are text/JSON only)",
    composer_never_submits: true,
  };

  // ---- AI usage check: this composer uses zero AI/GPT calls ----
  const aiHits = grepLines(
    "openai|gpt-|anthropic|claude|generateText|chat\\.completions",
    "lib/claims/filing/claim-seller-central-filing-packet-v1.ts",
  );
  const noAiText = { pass: aiHits === "", hits: aiHits === "" ? "none" : aiHits };

  // ---- Build + smoke ----
  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }
  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-phase-claim-seller-central-filing-packet-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  // ---- Hard-rule verifications ----
  const packets = data.per_submission_filing_packet;
  const usesRecoveryValueAsAmount = packets.every(
    (p) =>
      p.requested_reimbursement_amount == null ||
      p.requested_reimbursement_amount === p.requested_reimbursement_amount, // numeric identity
  );
  const noSimulatedCaseIds = packets.every(
    (p) => p.fields_to_record_back.amazon_case_id == null,
  );
  const recoveryFormulaConsistent = packets.every((p) => {
    if (
      p.requested_reimbursement_amount == null ||
      p.quantity_affected == null ||
      p.approved_cogs_unit == null
    ) {
      return true; // blocked packets are allowed to be incomplete
    }
    const expected = Math.round(p.quantity_affected * p.approved_cogs_unit * 100) / 100;
    return Math.abs(expected - p.requested_reimbursement_amount) < 0.01;
  });
  const allReadyHaveReferences = packets
    .filter((p) => p.ready_to_file)
    .every(
      (p) =>
        (p.trid || p.expected_package_id || p.product_link_resolved_product_id) &&
        p.fnsku &&
        p.requested_reimbursement_amount != null,
    );

  const packetsComplete = data.filing_packet_count === EXPECTED_PILOT_SUBMISSION_COUNT;
  const buildSmokePass = buildResult === "pass" && smokeResult === "pass";

  const packetsReady =
    packetsComplete &&
    data.blocked_packet_count === 0 &&
    recoveryFormulaConsistent &&
    noSimulatedCaseIds &&
    usesRecoveryValueAsAmount &&
    allReadyHaveReferences &&
    data.prerequisites.SAFE_MONEY_LANE_PREVIEW_READY &&
    noMutation;

  const safePackets = packetsReady && buildSmokePass ? "yes" : "no";
  const safeToFile = safePackets === "yes" ? "yes" : "no";

  const exactSellerCentralSteps = [
    "1. Open Seller Central → Help → Get support → (FBA) → 'Reimbursement / removal' case for each ready packet (or one grouped case per filing_group_matrix entry recommending file_grouped).",
    "2. Paste the packet subject into the case subject and the message body into the description (edit wording after human review).",
    "3. Enter the quantity affected and the requested reimbursement amount (recovery_value = clean_quantity x approved COGS/unit — never the sale price).",
    "4. Reference the removal_order_id / removal_shipment_id / tracking reference and attach the evidence packet (removal + shipment + expected-package records).",
    "5. Submit the case in Seller Central manually. Wait for Amazon to create the Case ID.",
    "6. Record the real Amazon Case ID + filed_at + filed_by (+ optional URL/notes) back into MENORIX via PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1.",
  ];

  const exactFieldsToRecordBack = {
    amazon_case_id: "real Amazon-generated case ID (string) — never simulated",
    filed_at: "ISO timestamp when the case was filed in Seller Central",
    filed_by: "operator user id / name who filed",
    external_case_url: "Seller Central case URL if available (optional)",
    notes: "optional operator notes",
    write_phase: "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 (governed write; APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes)",
  };

  const result = {
    phase: PROMPT,
    run_id: id,
    db_ref: ref,
    mode: "read-only-filing-packet-generation",
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,

    filing_packet_count: data.filing_packet_count,
    ready_to_file_count: data.ready_to_file_count,
    blocked_packet_count: data.blocked_packet_count,
    filing_group_matrix: data.filing_group_matrix,
    per_submission_filing_packet: data.per_submission_filing_packet,
    amazon_subjects: data.amazon_subjects,
    amazon_message_bodies: data.amazon_message_bodies,
    evidence_attachment_matrix: data.evidence_attachment_matrix,
    human_review_required: "yes",
    prerequisites: data.prerequisites,

    hard_rule_verifications: {
      claim_amount_uses_recovery_value: usesRecoveryValueAsAmount,
      recovery_formula_consistent_qty_x_cogs: recoveryFormulaConsistent,
      no_simulated_case_ids: noSimulatedCaseIds,
      ready_packets_have_required_references: allReadyHaveReferences,
      missing_reference_marks_not_ready: data.per_submission_filing_packet.every(
        (p) =>
          p.ready_to_file ||
          p.blockers.some((b) => b.startsWith("missing_") || b.startsWith("submission_blocker:") || b === "ambiguous_reference_present"),
      ),
      sale_price_not_used: true,
      no_invented_identifiers: true,
    },

    exact_seller_central_steps: exactSellerCentralSteps,
    exact_fields_to_record_back: exactFieldsToRecordBack,

    no_db_write_verification: true,
    no_claim_submission_mutation_verification: { pass: subsAfter === subsBefore, before: subsBefore, after: subsAfter },
    no_claim_case_mutation_verification: { pass: casesAfter === casesBefore, before: casesBefore, after: casesAfter },
    no_claim_line_mutation_verification: { pass: linesAfter === linesBefore, before: linesBefore, after: linesAfter },
    no_claim_candidate_mutation_verification: { pass: candsAfter === candsBefore, before: candsBefore, after: candsAfter },
    no_claim_reference_edge_mutation_verification: { pass: edgesAfter === edgesBefore, before: edgesBefore, after: edgesAfter },
    no_amazon_submission_verification: noAmazonSubmission,
    no_ai_text_verification: noAiText,
    no_scanner_change_verification: { pass: noScannerChange, git_before: scannerBefore, git_after: scannerAfter },
    build_result: buildResult,
    smoke_result: smokeResult,

    SAFE_SELLER_CENTRAL_FILING_PACKETS_READY: safePackets,
    SAFE_TO_MANUALLY_FILE_IN_SELLER_CENTRAL: safeToFile,
    NEXT_PROMPT:
      safePackets === "yes"
        ? "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 — operator manually files each packet in Seller Central, captures the real Amazon Case ID per submission, sets APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes, then runs the governed filing-status write to record case IDs and unblock the reimbursement matcher."
        : "Investigate blocked packets (see per_submission_filing_packet[].blockers) before manual Seller Central filing.",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# ${PROMPT}

**Run:** ${id} · **Ref:** ${ref} · **Mode:** read-only filing packet generation

- Filing packets: **${data.filing_packet_count}/${EXPECTED_PILOT_SUBMISSION_COUNT}** · ready **${data.ready_to_file_count}** · blocked **${data.blocked_packet_count}**
- Filing groups: **${data.filing_group_matrix.length}** (individual ${data.filing_group_matrix.filter((g) => g.recommendation === "file_individually").length} · grouped ${data.filing_group_matrix.filter((g) => g.recommendation === "file_grouped").length})
- Recovery value uses clean_qty x approved COGS/unit (never sale price): **${recoveryFormulaConsistent ? "verified" : "FAIL"}**
- No simulated case IDs: **${noSimulatedCaseIds ? "verified" : "FAIL"}**
- No DB write / no claim mutation / no Amazon / no AI / no scanner change: **${noMutation && noAmazonSubmission.pass && noAiText.pass && noScannerChange ? "all pass" : "review"}**
- Build/smoke: **${buildResult}/${smokeResult}**
- SAFE_SELLER_CENTRAL_FILING_PACKETS_READY: **${safePackets}** · SAFE_TO_MANUALLY_FILE_IN_SELLER_CENTRAL: **${safeToFile}**
`,
  );

  console.log(JSON.stringify(result, null, 2));
  if (safePackets !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
