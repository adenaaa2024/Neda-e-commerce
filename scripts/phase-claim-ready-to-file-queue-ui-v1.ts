/**
 * PHASE-CLAIM-READY-TO-FILE-QUEUE-UI-V1
 *
 * Operational UI build + read-only correctness audit for the Ready-to-File queue
 * (/claim-center/ready-to-file). Verifies the read-model classifies pilot packets
 * ready vs blocked, the route + nav exist, the Seller Central copy + guarded Case ID
 * sections are wired, and NOTHING mutates claim_* / scanner / Amazon.
 *
 *   npx tsx scripts/phase-claim-ready-to-file-queue-ui-v1.ts [--run-id=<UTC>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const PROMPT = "PHASE-CLAIM-READY-TO-FILE-QUEUE-UI-V1";
const OUT = ".cursor/audit-reports/phase-claim-ready-to-file-queue-ui-v1";
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

function fileHas(rel: string, needle: string): boolean {
  try {
    return fs.readFileSync(path.join(process.cwd(), rel), "utf8").includes(needle);
  } catch {
    return false;
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
  const data = await composeClaimReadyToFileQueueV1(client, ORG, STORE, {
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

  const noClaimMutation =
    subsAfter === subsBefore &&
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candsAfter === candsBefore &&
    edgesAfter === edgesBefore;
  const noScannerChange = scannerBefore === scannerAfter;

  // ---- Route + nav presence (static) ----
  const route_added = {
    page: fs.existsSync(path.join(process.cwd(), "app/claim-center/ready-to-file/page.tsx")),
    api: fs.existsSync(path.join(process.cwd(), "app/api/claims/center/ready-to-file/route.ts")),
    view: fs.existsSync(
      path.join(process.cwd(), "components/claim-center/ready-to-file/ReadyToFileView.tsx"),
    ),
    drawer: fs.existsSync(
      path.join(process.cwd(), "components/claim-center/ready-to-file/ReadyToFileDetailDrawer.tsx"),
    ),
  };
  const nav_added = {
    financial_nav: fileHas(
      "lib/claims/submission/claim-reimbursement-tracking-nav.ts",
      "/claim-center/ready-to-file",
    ),
    filing_recovery_nav: fileHas(
      "components/claim-center/claim-center-nav-config.ts",
      "/claim-center/ready-to-file",
    ),
    page_contract: fileHas("lib/claims/center/claim-center-v2-page-contract.ts", "ready_to_file"),
  };

  // ---- No Amazon submit / no browser automation (static) ----
  const amazonSubmitHits = grepLines(
    "submitClaimToAmazon|amazonSubmit|createAmazonCase|automateSellerCentral|postToAmazon",
    "app/claim-center/ready-to-file app/api/claims/center/ready-to-file components/claim-center/ready-to-file lib/claims/filing/claim-ready-to-file-queue-v1.ts",
  );
  const remoteNavHits = grepLines(
    "goto\\(.*https?://",
    "app/claim-center/ready-to-file components/claim-center/ready-to-file lib/claims/filing/claim-ready-to-file-queue-v1.ts",
  );
  const no_amazon_submission_verification = {
    pass: amazonSubmitHits === "" && remoteNavHits === "",
    amazon_submit_symbols: amazonSubmitHits === "" ? "none" : amazonSubmitHits,
    remote_browser_navigation: remoteNavHits === "" ? "none" : remoteNavHits,
    case_id_section_submits: false,
  };

  // ---- No write op in the new read-model lib / API ----
  const libWriteHits = grepLines(
    "\\.update\\(|\\.insert\\(|\\.delete\\(|\\.upsert\\(",
    "lib/claims/filing/claim-ready-to-file-queue-v1.ts app/api/claims/center/ready-to-file/route.ts",
  );
  const no_write_op_verification = { pass: libWriteHits === "", hits: libWriteHits === "" ? "none" : libWriteHits };

  // ---- No AI/GPT in the read-model ----
  const aiHits = grepLines(
    "openai|gpt-|anthropic|claude|generateText|chat\\.completions",
    "lib/claims/filing/claim-ready-to-file-queue-v1.ts",
  );
  const no_ai_text_verification = { pass: aiHits === "", hits: aiHits === "" ? "none" : aiHits };

  // ---- Build + smoke ----
  let build_result = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    build_result = "pass";
  } catch (e) {
    build_result = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }
  let smoke_result = "skipped";
  try {
    execSync("npx tsx scripts/smoke-phase-claim-ready-to-file-queue-ui-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smoke_result = "pass";
  } catch (e) {
    smoke_result = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  // ---- Correctness-audit verifications ----
  const allRows = [...data.ready_rows, ...data.blocked_rows];
  const per_claim_ready_matrix = allRows.map((r) => ({
    claim_submission_id: r.claim_submission_id,
    claim_family: r.claim_family,
    ready_to_file: r.ready_to_file,
    blockers: r.blockers,
    audit: r.audit.map((a) => ({ id: a.id, pass: a.pass, detail: a.detail })),
  }));
  const per_claim_reference_matrix = allRows.map((r) => ({
    claim_submission_id: r.claim_submission_id,
    primary_trid: r.reference_health.primary_trid,
    trid_source: r.reference_health.trid_source,
    expected_package_id: r.reference_health.expected_package_id,
    reference_edge_count: r.reference_health.reference_edge_count,
    ambiguous_reference_count: r.reference_health.ambiguous_reference_count,
    event_datetime_used_as_filter: r.reference_health.event_datetime_used_as_filter,
    removal_order_id: r.removal_order_id,
    removal_shipment_id: r.removal_shipment_id,
  }));
  const per_claim_filing_packet_matrix = allRows.map((r) => ({
    claim_submission_id: r.claim_submission_id,
    recovery_value: r.recovery_value,
    clean_quantity: r.clean_quantity,
    approved_cogs_unit: r.approved_cogs_unit,
    fnsku: r.fnsku,
    sku: r.sku,
    asin: r.asin,
    evidence_status: r.evidence_status,
    filing_packet_status: r.filing_packet_status,
    amazon_case_id_status: r.amazon_case_id_status,
    recovery_formula: r.recovery_formula,
  }));

  // Recovery amount must equal qty x COGS (never sale price) for every ready row.
  const recoveryFormulaConsistent = data.ready_rows.every((r) => {
    if (r.recovery_value == null || r.clean_quantity == null || r.approved_cogs_unit == null) return false;
    const expected = Math.round(r.clean_quantity * r.approved_cogs_unit * 100) / 100;
    return Math.abs(expected - r.recovery_value) < 0.01;
  });
  const readyRowsPassAllGates = data.ready_rows.every((r) => r.audit.every((a) => a.pass));
  const blockedRowsHaveFailedGate = data.blocked_rows.every(
    (r) => r.blockers.length > 0 || r.audit.some((a) => !a.pass),
  );

  // Seller Central copy section present + populated on every ready row.
  const seller_central_copy_section_verified = data.ready_rows.every(
    (r) =>
      r.packet.seller_central_case_subject.length > 0 &&
      r.packet.seller_central_message_body.includes("DID NOT CONTACT AMAZON") &&
      r.recovery_value != null &&
      r.packet.attachments_to_include.length > 0,
  );
  // Case ID recording section: disabled by default, guarded, never submits.
  const c = data.case_id_recording;
  const case_id_recording_section_verified =
    c.enabled_by_default === false &&
    c.write_guarded === true &&
    c.does_not_submit_to_amazon === true &&
    c.fields.some((f) => f.key === "amazon_case_id") &&
    c.fields.some((f) => f.key === "filed_at") &&
    c.fields.some((f) => f.key === "filed_by") &&
    c.fields.some((f) => f.key === "external_case_url") &&
    c.fields.some((f) => f.key === "notes");

  const expectedFamilyCounts =
    (data.summary_cards.family_counts["removal_shipment_missing"] ?? 0) === 6 &&
    (data.summary_cards.family_counts["removal_order_discrepancy"] ?? 0) === 4;

  const queueComplete = allRows.length === EXPECTED_PILOT_SUBMISSION_COUNT;
  const buildSmokePass = build_result === "pass" && smoke_result === "pass";

  const uiReady =
    queueComplete &&
    route_added.page &&
    route_added.api &&
    route_added.view &&
    route_added.drawer &&
    nav_added.financial_nav &&
    nav_added.filing_recovery_nav &&
    nav_added.page_contract &&
    readyRowsPassAllGates &&
    blockedRowsHaveFailedGate &&
    recoveryFormulaConsistent &&
    data.scanner_only_claims_detected === 0 &&
    data.simulated_case_ids_used === 0 &&
    data.fake_scan_codes_detected === 0 &&
    data.sale_price_used_as_amount_detected === 0 &&
    seller_central_copy_section_verified &&
    case_id_recording_section_verified &&
    no_amazon_submission_verification.pass &&
    no_write_op_verification.pass &&
    no_ai_text_verification.pass &&
    noClaimMutation &&
    noScannerChange;

  const SAFE_READY_TO_FILE_UI_READY = uiReady && buildSmokePass ? "yes" : "no";
  const SAFE_TO_MANUALLY_FILE_FROM_UI =
    SAFE_READY_TO_FILE_UI_READY === "yes" && data.summary_cards.ready_to_file_count > 0 ? "yes" : "no";

  const result = {
    phase: PROMPT,
    run_id: id,
    db_ref: ref,
    mode: "operational-ui-build + read-only-correctness-audit",
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,

    route_added,
    nav_added,
    ready_to_file_count: data.summary_cards.ready_to_file_count,
    blocked_count: data.summary_cards.missing_blockers_count,
    total_recovery_value: data.summary_cards.total_recovery_value,
    claim_family_counts: data.summary_cards.family_counts,
    expected_family_counts_6_4: expectedFamilyCounts,
    scanner_only_claims_detected: data.scanner_only_claims_detected,
    simulated_case_ids_used: data.simulated_case_ids_used,
    fake_scan_codes_detected: data.fake_scan_codes_detected,
    sale_price_used_as_amount_detected: data.sale_price_used_as_amount_detected,

    per_claim_ready_matrix,
    per_claim_reference_matrix,
    per_claim_filing_packet_matrix,
    filing_group_matrix: data.filing_group_matrix,

    seller_central_copy_section_verified,
    case_id_recording_section_verified,

    correctness_audit: {
      ready_rows_pass_all_gates: readyRowsPassAllGates,
      blocked_rows_have_failed_gate: blockedRowsHaveFailedGate,
      recovery_amount_is_qty_x_cogs_not_sale_price: recoveryFormulaConsistent,
    },

    no_amazon_submission_verification,
    no_claim_mutation_verification: {
      pass: noClaimMutation,
      claim_submissions: { before: subsBefore, after: subsAfter },
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_candidates: { before: candsBefore, after: candsAfter },
      claim_reference_edges: { before: edgesBefore, after: edgesAfter },
    },
    no_write_op_verification,
    no_ai_text_verification,
    no_scanner_change_verification: { pass: noScannerChange, git_before: scannerBefore, git_after: scannerAfter },
    build_result,
    smoke_result,

    SAFE_READY_TO_FILE_UI_READY,
    SAFE_TO_MANUALLY_FILE_FROM_UI,
    NEXT_PROMPT:
      SAFE_READY_TO_FILE_UI_READY === "yes"
        ? "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 — operator opens a packet in /claim-center/ready-to-file, files manually in Seller Central, then sets APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes and runs the governed filing-status write to record the real Amazon Case ID per submission and unblock the reimbursement matcher."
        : "Investigate failed audit gates / blocked rows (see per_claim_ready_matrix[].blockers) before exposing the Ready-to-File UI for manual filing.",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# ${PROMPT}

**Run:** ${id} · **Ref:** ${ref} · **Mode:** operational UI build + read-only correctness audit

- Route added: page **${route_added.page}** · api **${route_added.api}** · view **${route_added.view}** · drawer **${route_added.drawer}**
- Nav added: financial **${nav_added.financial_nav}** · filing/recovery **${nav_added.filing_recovery_nav}** · page contract **${nav_added.page_contract}**
- Ready to file: **${data.summary_cards.ready_to_file_count}/${EXPECTED_PILOT_SUBMISSION_COUNT}** · blocked **${data.summary_cards.missing_blockers_count}**
- Total recovery value: **$${data.summary_cards.total_recovery_value}** · families ${JSON.stringify(data.summary_cards.family_counts)}
- Audit flags — scanner-only **${data.scanner_only_claims_detected}** · fake scan codes **${data.fake_scan_codes_detected}** · simulated case IDs **${data.simulated_case_ids_used}** · sale-price amount **${data.sale_price_used_as_amount_detected}**
- Seller Central copy verified: **${seller_central_copy_section_verified}** · Case ID recording (guarded) verified: **${case_id_recording_section_verified}**
- No claim mutation / no scanner change / no Amazon / no AI / no write op: **${noClaimMutation && noScannerChange && no_amazon_submission_verification.pass && no_ai_text_verification.pass && no_write_op_verification.pass ? "all pass" : "review"}**
- Build/smoke: **${build_result}/${smoke_result}**
- SAFE_READY_TO_FILE_UI_READY: **${SAFE_READY_TO_FILE_UI_READY}** · SAFE_TO_MANUALLY_FILE_FROM_UI: **${SAFE_TO_MANUALLY_FILE_FROM_UI}**
`,
  );

  console.log(JSON.stringify(result, null, 2));
  if (SAFE_READY_TO_FILE_UI_READY !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
