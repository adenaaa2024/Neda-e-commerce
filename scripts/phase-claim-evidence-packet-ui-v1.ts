/**
 * PHASE-CLAIM-EVIDENCE-PACKET-UI-V1 — read-only evidence packet UI on pilot review
 *   npx tsx scripts/phase-claim-evidence-packet-ui-v1.ts --run-id=<UTC>
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
import {
  DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
  buildClaimPilotReviewReadmodel,
} from "../lib/claims/pilot/claim-pilot-review-readmodel";
import {
  EVIDENCE_PACKET_DRAWER_FIELDS,
  deriveEvidencePacketReadinessBadge,
  verifyEvidencePacketDisplay,
} from "../lib/claims/pilot/claim-evidence-packet-ui-contract";
import {
  PILOT_REVIEW_DISABLED_ACTIONS,
  familyDistributionMatchesExpected,
} from "../lib/claims/pilot/claim-pilot-review-ui-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-evidence-packet-ui-v1";
const PREVIEW_RESULTS =
  ".cursor/audit-reports/phase-claim-evidence-packet-preview-v1/20260615T091500Z/results.json";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const FILES_CHANGED = [
  "lib/claims/pilot/claim-evidence-packet-ui-contract.ts",
  "lib/claims/pilot/claim-pilot-review-ui-contract.ts",
  "components/claim-center/pilot/ClaimPilotReviewEvidencePacketSection.tsx",
  "components/claim-center/pilot/ClaimPilotReviewDetailDrawer.tsx",
  "components/claim-center/pilot/ClaimPilotReviewView.tsx",
  "scripts/phase-claim-evidence-packet-ui-v1.ts",
  "scripts/smoke-claim-evidence-packet-ui-v1.ts",
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

function loadPrerequisites(): void {
  const p = path.join(process.cwd(), PREVIEW_RESULTS);
  if (!fs.existsSync(p)) throw new Error(`BLOCKED: preview evidence missing at ${PREVIEW_RESULTS}`);
  const preview = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;
  if (preview.SAFE_EVIDENCE_PACKET_PREVIEW_READY !== "yes") {
    throw new Error("BLOCKED: SAFE_EVIDENCE_PACKET_PREVIEW_READY must be yes");
  }
  if (preview.SAFE_TO_BUILD_EVIDENCE_PACKET_UI !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_BUILD_EVIDENCE_PACKET_UI must be yes");
  }
}

function packetUiSummary(packet: ClaimEvidencePacketV1) {
  const badge = deriveEvidencePacketReadinessBadge(packet);
  return {
    candidate_id: packet.candidate_id,
    family_key_v3: packet.family_key_v3,
    readiness_badge: badge,
    ready_for_case_creation: packet.readiness.ready_for_case_creation,
    blockers: packet.blocker_flags,
    warnings: packet.review_flags,
    display_check: verifyEvidencePacketDisplay(packet),
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
    await client.from("claim_candidates").select("id", { count: "exact", head: true })
  ).count ?? 0;
  const casesBefore = (await client.from("claim_cases").select("id", { count: "exact", head: true })).count ?? 0;

  const pilotPayload = await buildClaimPilotReviewReadmodel(client, ORG, STORE, {
    intake_run_id: DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 100,
  });

  const shipmentRow = pilotPayload.rows.find((r) => r.family_key_v3 === "removal_shipment_missing");
  const orderRow = pilotPayload.rows.find((r) => r.family_key_v3 === "removal_order_discrepancy");
  if (!shipmentRow || !orderRow) {
    throw new Error("BLOCKED: need one removal_shipment_missing and one removal_order_discrepancy row");
  }

  const shipmentPacket = await composeClaimEvidencePacketV1(client, ORG, STORE, {
    candidate_id: shipmentRow.id,
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 1,
  });
  const orderPacket = await composeClaimEvidencePacketV1(client, ORG, STORE, {
    candidate_id: orderRow.id,
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 1,
  });

  const all50 = await composeClaimEvidencePacketV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 50,
  });

  const candidatesAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true })
  ).count ?? 0;
  const casesAfter = (await client.from("claim_cases").select("id", { count: "exact", head: true })).count ?? 0;
  const scannerAfter = scannerGitStatus();

  const shipmentPkt = shipmentPacket.packets[0]!;
  const orderPkt = orderPacket.packets[0]!;

  const sampleVerification = {
    removal_shipment_missing: packetUiSummary(shipmentPkt),
    removal_order_discrepancy: packetUiSummary(orderPkt),
  };

  const familyOk = familyDistributionMatchesExpected(pilotPayload.summary);
  const fiftyVisible = pilotPayload.rows.length === 50;
  const fiftyPackets = all50.packets.length === 50;
  const noDbWrite = candidatesBefore === candidatesAfter && casesBefore === casesAfter;
  const noScannerChange = scannerBefore === scannerAfter;

  let buildResult = "not_run";
  try {
    execSync("npm run build", { encoding: "utf8", stdio: "pipe", cwd: process.cwd() });
    buildResult = "pass";
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    buildResult = `fail: ${(err.stderr ?? err.message ?? "build failed").slice(0, 400)}`;
  }

  let smokeResult = "not_run";
  try {
    execSync(`npx tsx scripts/smoke-claim-evidence-packet-ui-v1.ts --run-id=${id}`, {
      encoding: "utf8",
      stdio: "pipe",
      cwd: process.cwd(),
    });
    smokeResult = "pass";
  } catch {
    smokeResult = "fail";
  }

  const disabledIds = PILOT_REVIEW_DISABLED_ACTIONS.map((a) => a.id);
  const disabledOk =
    disabledIds.includes("approve") &&
    disabledIds.includes("reject") &&
    disabledIds.includes("create_case") &&
    disabledIds.includes("build_pdf") &&
    disabledIds.includes("submit_claim");

  const uiPass =
    fiftyVisible &&
    fiftyPackets &&
    familyOk &&
    noDbWrite &&
    noScannerChange &&
    buildResult === "pass" &&
    smokeResult === "pass" &&
    disabledOk &&
    sampleVerification.removal_shipment_missing.display_check.identity &&
    sampleVerification.removal_order_discrepancy.display_check.identity;

  const results = {
    prompt: "PHASE-CLAIM-EVIDENCE-PACKET-UI-V1",
    run_id: id,
    mode: "read-only-ui",
    original_ref: PRODUCTION_REF,
    pilot_intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    files_changed: FILES_CHANGED,
    UI_sections_added: ["Evidence packet section in pilot detail drawer"],
    evidence_packet_drawer_fields: [...EVIDENCE_PACKET_DRAWER_FIELDS],
    readiness_badge_behavior: {
      ready_for_case_planning: "ready=yes, no blockers, no warnings",
      needs_evidence_review: "ready=yes with review_flags",
      blocked: "blocker_flags present or ready=no",
    },
    sample_candidate_ui_verification: sampleVerification,
    disabled_actions_verification: {
      pass: disabledOk,
      actions: PILOT_REVIEW_DISABLED_ACTIONS.map((a) => a.label),
    },
    pilot_rows_visible: pilotPayload.rows.length,
    evidence_packets_composed: all50.packets.length,
    family_distribution: pilotPayload.summary.by_family_key_v3,
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
      pass: noScannerChange,
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_REVIEW_EVIDENCE_PACKET_UI: uiPass ? "yes" : "no",
    SAFE_TO_PLAN_CASE_CREATION_CONTRACT: uiPass ? "yes" : "no",
    NEXT_PROMPT: uiPass
      ? "PHASE-CLAIM-CASE-CREATION-CONTRACT-V1 — plan read-only case creation contract from evidence packet readiness"
      : "PHASE-CLAIM-EVIDENCE-PACKET-UI-REMEDIATION-V1 — fix failing UI checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Evidence packet UI V1

**Run:** ${id} · **Ref:** ${PRODUCTION_REF}

- Pilot rows visible: **${pilotPayload.rows.length}**
- Evidence packets: **${all50.packets.length}**
- Sample families verified: shipment + order discrepancy
- SAFE_TO_REVIEW_EVIDENCE_PACKET_UI: **${results.SAFE_TO_REVIEW_EVIDENCE_PACKET_UI}**
`,
  );

  console.log(
    JSON.stringify({
      ok: uiPass,
      run_id: id,
      rows: pilotPayload.rows.length,
      packets: all50.packets.length,
      SAFE_TO_REVIEW_EVIDENCE_PACKET_UI: results.SAFE_TO_REVIEW_EVIDENCE_PACKET_UI,
      outDir,
    }),
  );
  if (!uiPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
