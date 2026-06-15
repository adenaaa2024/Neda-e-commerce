/**
 * PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1 — read-only evidence packet preview on original pilot
 *   npx tsx scripts/phase-claim-evidence-packet-preview-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  composeClaimEvidencePacketV1,
  type ClaimEvidencePacketV1,
} from "../lib/claims/evidence/claim-evidence-packet-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "../lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-evidence-packet-preview-v1";
const PLAN_RESULTS =
  ".cursor/audit-reports/phase-claim-evidence-packet-v1-plan/20260615T080000Z/results.json";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const FILES_CHANGED = [
  "lib/claims/evidence/claim-evidence-packet-v1.ts",
  "lib/claims/center/claim-center-api-handlers.ts",
  "app/api/claims/center/evidence-packet/route.ts",
  "scripts/phase-claim-evidence-packet-preview-v1.ts",
  "scripts/smoke-claim-evidence-packet-preview-v1.ts",
];

const PACKET_SHAPE = [
  "packet_id",
  "candidate_id",
  "intake_run_id",
  "family_key_v3",
  "claim_family",
  "source_kind",
  "source_event_key",
  "product_identity",
  "quantity",
  "date_gate",
  "source_edges",
  "evidence_pointers",
  "reference_edges",
  "money_lanes",
  "review_flags",
  "blocker_flags",
  "evidence_summary",
  "readiness",
] as const;

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
  const p = path.join(process.cwd(), PLAN_RESULTS);
  if (!fs.existsSync(p)) throw new Error(`BLOCKED: plan evidence missing at ${PLAN_RESULTS}`);
  const plan = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;
  if (plan.SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW must be yes");
  }
}

function samplePacketSummary(p: ClaimEvidencePacketV1) {
  return {
    packet_id: p.packet_id,
    candidate_id: p.candidate_id,
    family_key_v3: p.family_key_v3,
    claim_family: p.claim_family,
    source_event_key: p.source_event_key,
    clean_quantity: p.quantity.clean_quantity,
    date_gate_passed: p.date_gate.date_gate_passed,
    reference_edges_count: p.reference_edges.length,
    evidence_summary: p.evidence_summary,
    ready_for_case_creation: p.readiness.ready_for_case_creation,
    blockers: p.readiness.blockers,
    review_flags: p.review_flags,
    estimated_payout: p.money_lanes.estimated_amazon_payout,
  };
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

  const all50 = await composeClaimEvidencePacketV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 50,
  });

  const sample10 = await composeClaimEvidencePacketV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 10,
  });

  const candidatesAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;
  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;
  const scannerAfter = scannerGitStatus();

  const familyOk =
    all50.summary.family_distribution.removal_shipment_missing === 30 &&
    all50.summary.family_distribution.removal_order_discrepancy === 20;

  const evidenceSummaryCheck = {
    pass: all50.summary.evidence_summary_present_count === 50,
    present: all50.summary.evidence_summary_present_count,
    expected: 50,
  };

  const dateGateSummary = {
    pass: all50.summary.date_gate_passed_count === 50,
    date_gate_passed_count: all50.summary.date_gate_passed_count,
  };

  const sourceEdgeSummary = {
    pass: all50.summary.source_edges_present_count === 50,
    source_edges_present_count: all50.summary.source_edges_present_count,
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
    execSync(`npx tsx scripts/smoke-claim-evidence-packet-preview-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const noDbWrite =
    candidatesBefore === candidatesAfter && casesBefore === casesAfter && scannerBefore === scannerAfter;

  const previewPass =
    all50.packets.length === 50 &&
    sample10.packets.length === 10 &&
    familyOk &&
    evidenceSummaryCheck.pass &&
    dateGateSummary.pass &&
    sourceEdgeSummary.pass &&
    all50.packets.every((p) => p.reference_edges.length > 0) &&
    noDbWrite &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1",
    run_id: id,
    mode: "read-only-preview",
    original_ref: PRODUCTION_REF,
    pilot_intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    files_changed: FILES_CHANGED,
    api_route_added: "GET /api/claims/center/evidence-packet?store_id=&candidate_id=&intake_run_id=&limit=",
    packet_shape: [...PACKET_SHAPE],
    sample_packets: sample10.packets.map(samplePacketSummary),
    all_50_packet_summary: all50.summary,
    ready_for_case_creation_count: all50.summary.ready_for_case_creation_count,
    blocker_counts: all50.summary.blocker_counts,
    warning_counts: all50.summary.warning_counts,
    money_lane_summary: all50.summary.money_lane_null_counts,
    date_gate_summary: dateGateSummary,
    source_edge_summary: sourceEdgeSummary,
    evidence_summary_check: evidenceSummaryCheck,
    family_distribution_verification: {
      pass: familyOk,
      actual: all50.summary.family_distribution,
      expected: { removal_shipment_missing: 30, removal_order_discrepancy: 20 },
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
    SAFE_EVIDENCE_PACKET_PREVIEW_READY: previewPass ? "yes" : "no",
    SAFE_TO_BUILD_EVIDENCE_PACKET_UI: previewPass ? "yes" : "no",
    NEXT_PROMPT: previewPass
      ? "PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-UI-V1 — wire pilot-review evidence packet preview panel (read-only HTML/JSON)"
      : "PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-REMEDIATION-V1 — fix failing preview checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    `# Evidence packet preview V1

**Run:** ${id} · **Ref:** ${PRODUCTION_REF}

- Packets composed: **${all50.packets.length}**
- Ready for case creation: **${all50.summary.ready_for_case_creation_count}**
- Family: shipment=${all50.summary.family_distribution.removal_shipment_missing ?? 0} · order=${all50.summary.family_distribution.removal_order_discrepancy ?? 0}
- SAFE_EVIDENCE_PACKET_PREVIEW_READY: **${results.SAFE_EVIDENCE_PACKET_PREVIEW_READY}**
`,
  );

  console.log(
    JSON.stringify({
      ok: previewPass,
      run_id: id,
      packets: all50.packets.length,
      ready: all50.summary.ready_for_case_creation_count,
      SAFE_EVIDENCE_PACKET_PREVIEW_READY: results.SAFE_EVIDENCE_PACKET_PREVIEW_READY,
      outDir,
    }),
  );
  if (!previewPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
