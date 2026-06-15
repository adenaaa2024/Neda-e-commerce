/**
 * PHASE-CLAIM-EVIDENCE-PACKET-V1-PLAN — read-only evidence packet planning for original pilot
 *   npx tsx scripts/phase-claim-evidence-packet-v1-plan.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { composeClaimEvidencePacket } from "../lib/claims/evidence/claim-evidence-packet-composer";
import {
  BLOCKER_RULES,
  CASE_CREATION_PREREQUISITES,
  DATE_RULES,
  EVIDENCE_SOURCES_REQUIRED,
  EXISTING_EVIDENCE_CODE,
  FUTURE_PDF_EXPORT_STEP,
  MONEY_RULES,
  NO_WRITE_SMOKE_TESTS_PLANNED,
  ORIGINAL_PILOT_INTAKE_RUN_ID,
  ORIGINAL_REF,
  PACKET_API_PLAN,
  PACKET_SCHEMA_PROPOSAL,
  PACKET_UI_PLAN,
  PDF_GENERATION_DEFERRED,
  SOURCE_READER_PLAN,
} from "../lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import {
  DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
  buildClaimPilotReviewReadmodel,
} from "../lib/claims/pilot/claim-pilot-review-readmodel";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-evidence-packet-v1-plan";
const REVIEW_UI_RESULTS =
  ".cursor/audit-reports/phase-claim-candidate-review-ui-original-pilot-v1/20260615T070000Z/results.json";
const RESTORE_RESULTS =
  ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-restore-for-review-v1/20260615T060000Z/results.json";

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

function loadPrerequisites(): void {
  const reviewPath = path.join(process.cwd(), REVIEW_UI_RESULTS);
  if (!fs.existsSync(reviewPath)) {
    throw new Error(`BLOCKED: pilot review UI evidence missing at ${REVIEW_UI_RESULTS}`);
  }
  const review = JSON.parse(fs.readFileSync(reviewPath, "utf8")) as Record<string, string>;
  if (review.SAFE_TO_REVIEW_ORIGINAL_PILOT_CANDIDATES_IN_UI !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_REVIEW_ORIGINAL_PILOT_CANDIDATES_IN_UI must be yes");
  }
  if (review.SAFE_TO_PLAN_EVIDENCE_PACKET_V1 !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_PLAN_EVIDENCE_PACKET_V1 must be yes");
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  loadPrerequisites();

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

  const candidatesBefore = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const pilotPayload = await buildClaimPilotReviewReadmodel(client, ORG, STORE, {
    intake_run_id: DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 100,
  });

  const pilotIds = pilotPayload.rows.map((r) => r.id);
  const sampleSingleId = pilotIds[0]!;
  const sampleGroupedIds = pilotIds.slice(0, 3);

  const singleCompose = await composeClaimEvidencePacket(client, {
    organizationId: ORG,
    candidateIds: [sampleSingleId],
  });

  const groupedCompose = await composeClaimEvidencePacket(client, {
    organizationId: ORG,
    candidateIds: sampleGroupedIds,
    title: "Pilot sample grouped preview (plan only)",
  });

  let batchComposeCount = 0;
  let batchComposeOk = 0;
  const batchWarnings = new Set<string>();
  for (let i = 0; i < pilotIds.length; i += 10) {
    const chunk = pilotIds.slice(i, i + 10);
    batchComposeCount += 1;
    const res = await composeClaimEvidencePacket(client, { organizationId: ORG, candidateIds: chunk });
    if (res.ok) {
      batchComposeOk += 1;
      for (const w of res.packet.warnings) batchWarnings.add(w.code);
    }
  }

  const candidatesAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const scannerAfter = scannerGitStatus();

  const gapAnalysis = {
    composer_covers: [
      "source_report snapshot (expected_packages)",
      "reference_graph (metadata + materialized edges)",
      "orbit_evidence_summary from metadata",
      "quantities.expected from expected_quantity",
      "base money columns (recovery_value, cogs_unit, expected_amount)",
      "grouping policy + warnings",
    ],
    v1_extension_needed: [
      "intake_run_id + family_key_v3 + dedupe_key + preview_id in identity block",
      "metadata.money_lanes (estimated_amazon_payout, observed_reimbursement, internal_cost_loss, reimbursement_gap)",
      "metadata.date_gate fields in dates block",
      "metadata.evidence_pointers explicit list",
      "product title + linkage confidence projection",
      "clean_quantity vs disputed context banner",
      "review flags from metadata.review_flags + money_lanes gaps",
      "pilot-review UI wire (currently disabled CTA)",
      "POST /api/claims/center/evidence-packet/preview route",
    ],
    pilot_compose_sample: {
      single_ok: singleCompose.ok,
      grouped_ok: groupedCompose.ok,
      batch_chunks: batchComposeCount,
      batch_ok: batchComposeOk,
      warning_codes_observed: [...batchWarnings],
      single_warnings: singleCompose.ok ? singleCompose.packet.warnings.map((w) => w.code) : [],
    },
  };

  let buildResult = "pending";
  let smokeResult = "pending";
  try {
    const lock = path.join(process.cwd(), ".next/lock");
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    execSync("npm run build", { stdio: "pipe", encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`;
  }
  try {
    execSync(`npx tsx scripts/smoke-claim-evidence-packet-v1-plan.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const noDbWrite =
    candidatesBefore === candidatesAfter && casesBefore === casesAfter && scannerBefore === scannerAfter;

  const planPass =
    pilotPayload.rows.length === 50 &&
    singleCompose.ok &&
    groupedCompose.ok &&
    batchComposeOk === batchComposeCount &&
    noDbWrite &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-EVIDENCE-PACKET-V1-PLAN",
    run_id: id,
    mode: "read-only-plan",
    original_ref: ORIGINAL_REF,
    pilot_intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    prerequisites: {
      review_ui: REVIEW_UI_RESULTS,
      restore: RESTORE_RESULTS,
      pilot_rows: pilotPayload.rows.length,
      family_distribution: pilotPayload.summary.by_family_key_v3,
    },
    existing_evidence_code_found: EXISTING_EVIDENCE_CODE,
    packet_schema_proposal: PACKET_SCHEMA_PROPOSAL,
    evidence_sources_required: [...EVIDENCE_SOURCES_REQUIRED],
    source_reader_plan: SOURCE_READER_PLAN,
    packet_api_plan: PACKET_API_PLAN,
    packet_ui_plan: PACKET_UI_PLAN,
    blocker_rules: BLOCKER_RULES,
    money_rules: MONEY_RULES,
    date_rules: DATE_RULES,
    case_creation_prerequisites: CASE_CREATION_PREREQUISITES,
    PDF_generation_deferred: PDF_GENERATION_DEFERRED.deferred ? "yes" : "no",
    pdf_deferred_detail: PDF_GENERATION_DEFERRED,
    future_pdf_export_step: FUTURE_PDF_EXPORT_STEP,
    no_write_smoke_tests_planned: [...NO_WRITE_SMOKE_TESTS_PLANNED],
    gap_analysis: gapAnalysis,
    compose_dry_run: {
      pilot_ids_count: pilotIds.length,
      sample_single_id: sampleSingleId,
      sample_grouped_ids: sampleGroupedIds,
      single_event_sections: singleCompose.ok ? singleCompose.packet.events.length : 0,
      grouped_event_sections: groupedCompose.ok ? groupedCompose.packet.events.length : 0,
    },
    no_db_write_verification: {
      pass: noDbWrite,
      claim_candidates_before: candidatesBefore,
      claim_candidates_after: candidatesAfter,
    },
    no_claim_candidate_mutation_verification: {
      pass: candidatesBefore === candidatesAfter,
      before: candidatesBefore,
      after: candidatesAfter,
    },
    no_claim_case_mutation_verification: {
      pass: casesBefore === casesAfter,
      before: casesBefore,
      after: casesAfter,
    },
    no_scanner_change_verification: {
      pass: scannerBefore === scannerAfter,
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW: planPass ? "yes" : "no",
    NEXT_PROMPT: planPass
      ? "PHASE-CLAIM-EVIDENCE-PACKET-V1-PREVIEW-IMPLEMENT — wire pilot-review preview UI + V1 projection + original pilot compose smoke (read-only)"
      : "PHASE-CLAIM-EVIDENCE-PACKET-V1-PLAN-REMEDIATION — fix failing plan checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    `# Evidence Packet V1 Plan

**Run:** ${id} · **Ref:** ${ORIGINAL_REF} · **Mode:** read-only plan

- Pilot rows: **${pilotPayload.rows.length}** @ \`${ORIGINAL_PILOT_INTAKE_RUN_ID}\`
- Reuse: Phase 7G \`composeClaimEvidencePacket\` + HTML renderer
- V1 extension: pilot identity/dates/money_lanes/review_flags projection layer
- API plan: \`POST /api/claims/center/evidence-packet/preview\`
- UI plan: wire \`/claim-center/pilot-review\` preview (read-only)
- PDF: **deferred**
- Compose dry-run: single=${singleCompose.ok ? "ok" : "fail"} · grouped=${groupedCompose.ok ? "ok" : "fail"} · batch=${batchComposeOk}/${batchComposeCount}
- SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW: **${results.SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW}**
`,
  );

  console.log(
    JSON.stringify({
      ok: planPass,
      run_id: id,
      pilot_rows: pilotPayload.rows.length,
      compose_batch_ok: `${batchComposeOk}/${batchComposeCount}`,
      SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW: results.SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW,
      outDir,
    }),
  );
  if (!planPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
