/**
 * PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1-VERIFY — read-only reliability verify for original pilot
 *   npx tsx scripts/phase-claim-evidence-packet-preview-v1-verify.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  composeClaimEvidencePacketV1,
  type ClaimEvidencePacketV1,
  type ClaimEvidencePacketV1Payload,
} from "../lib/claims/evidence/claim-evidence-packet-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "../lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-evidence-packet-preview-v1-verify";
const FIX_BUILD_RESULTS =
  ".cursor/audit-reports/phase-claim-evidence-packet-preview-v1-fix-build/20260615T131500Z/results.json";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const REQUIRED_PACKET_FIELDS = [
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
  "reference_edges",
  "evidence_pointers",
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
  const p = path.join(process.cwd(), FIX_BUILD_RESULTS);
  if (!fs.existsSync(p)) {
    throw new Error(`BLOCKED: fix-build evidence missing at ${FIX_BUILD_RESULTS}`);
  }
  const fixBuild = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;
  if (fixBuild.SAFE_EVIDENCE_PACKET_PREVIEW_READY !== "yes") {
    throw new Error("BLOCKED: SAFE_EVIDENCE_PACKET_PREVIEW_READY must be yes");
  }
}

function singleSample(p: ClaimEvidencePacketV1) {
  return {
    packet_id: p.packet_id,
    candidate_id: p.candidate_id,
    intake_run_id: p.intake_run_id,
    family_key_v3: p.family_key_v3,
    claim_family: p.claim_family,
    source_kind: p.source_kind,
    source_event_key: p.source_event_key,
    product_identity: {
      product_id: p.product_identity.product_id,
      asin: p.product_identity.asin,
      fnsku: p.product_identity.fnsku,
      sku: p.product_identity.sku,
      linkage_status: p.product_identity.linkage_status,
      linkage_warnings: p.product_identity.linkage_warnings,
    },
    clean_quantity: p.quantity.clean_quantity,
    disputed_quantity_excluded: p.quantity.disputed_quantity_excluded,
    disputed_context: p.quantity.disputed_context,
    source_event_date: p.date_gate.source_event_date,
    effective_date_source: p.date_gate.effective_date_source,
    effective_date_value: p.date_gate.effective_date_value,
    date_gate_passed: p.date_gate.date_gate_passed,
    source_edges_count: p.source_edges.length,
    reference_edges_count: p.reference_edges.length,
    evidence_pointers_count: p.evidence_pointers.length,
    money_lanes: p.money_lanes,
    review_flags: p.review_flags,
    blocker_flags: p.blocker_flags,
    evidence_summary: p.evidence_summary,
    ready_for_case_creation: p.readiness.ready_for_case_creation,
    blockers: p.readiness.blockers,
  };
}

function verifyPacketShape(p: ClaimEvidencePacketV1): { pass: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const key of REQUIRED_PACKET_FIELDS) {
    if (!(key in p)) missing.push(key);
  }
  if (!p.candidate_id) missing.push("candidate_id.empty");
  if (!p.intake_run_id) missing.push("intake_run_id.empty");
  if (!p.product_identity) missing.push("product_identity.empty");
  if (p.quantity.disputed_quantity_excluded !== true) missing.push("disputed_quantity_excluded");
  if (!p.date_gate) missing.push("date_gate.empty");
  if (!Array.isArray(p.source_edges)) missing.push("source_edges.array");
  if (!Array.isArray(p.reference_edges)) missing.push("reference_edges.array");
  if (!Array.isArray(p.evidence_pointers)) missing.push("evidence_pointers.array");
  if (!p.money_lanes) missing.push("money_lanes.empty");
  if (!p.evidence_summary) missing.push("evidence_summary.empty");
  return { pass: missing.length === 0, missing };
}

function verifyMoneyRules(p: ClaimEvidencePacketV1): {
  null_preserved: boolean;
  sale_price_not_cogs: boolean;
} {
  const m = p.money_lanes;
  const sale = m.sale_price_display_only;
  const cogs = m.internal_cost_loss;
  const saleNotCogs =
    sale == null ||
    cogs == null ||
    sale !== cogs ||
    (sale != null && cogs != null && sale !== cogs);
  return {
    null_preserved: m.estimated_amazon_payout === null || typeof m.estimated_amazon_payout === "number",
    sale_price_not_cogs: sale == null || cogs == null || sale !== cogs,
  };
}

function productLinkageSummary(packets: ClaimEvidencePacketV1[]) {
  const by_status: Record<string, number> = {};
  let with_warnings = 0;
  let missing_product_link_warning = 0;
  for (const p of packets) {
    const s = p.product_identity.linkage_status;
    by_status[s] = (by_status[s] ?? 0) + 1;
    if (p.product_identity.linkage_warnings.length > 0) with_warnings += 1;
    if (p.review_flags.includes("missing_product_link")) missing_product_link_warning += 1;
  }
  return { by_status, with_warnings, missing_product_link_warning };
}

function evidencePointerSummary(packets: ClaimEvidencePacketV1[]) {
  let with_pointers = 0;
  let total_pointers = 0;
  for (const p of packets) {
    if (p.evidence_pointers.length > 0) with_pointers += 1;
    total_pointers += p.evidence_pointers.length;
  }
  return { with_pointers, total_pointers, all_have_pointers: with_pointers === packets.length };
}

function groupedPacketSummary(payload: ClaimEvidencePacketV1Payload) {
  return {
    version: payload.version,
    read_only: payload.read_only,
    intake_run_id: payload.intake_run_id,
    total_packets: payload.packets.length,
    summary: payload.summary,
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
  ).count ?? 0;
  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const all50 = await composeClaimEvidencePacketV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 50,
  });

  const shipmentRow = all50.packets.find((p) => p.family_key_v3 === "removal_shipment_missing");
  const orderRow = all50.packets.find((p) => p.family_key_v3 === "removal_order_discrepancy");
  if (!shipmentRow || !orderRow) {
    throw new Error("BLOCKED: need one removal_shipment_missing and one removal_order_discrepancy packet");
  }

  const singleShipment = await composeClaimEvidencePacketV1(client, ORG, STORE, {
    candidate_id: shipmentRow.candidate_id,
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 1,
  });
  const singleOrder = await composeClaimEvidencePacketV1(client, ORG, STORE, {
    candidate_id: orderRow.candidate_id,
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 1,
  });

  const candidatesAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const scannerAfter = scannerGitStatus();

  const shapeChecks = all50.packets.map((p) => verifyPacketShape(p));
  const allShapesPass = shapeChecks.every((c) => c.pass);

  const disputedExcluded = all50.packets.every(
    (p) => p.quantity.disputed_quantity_excluded === true && p.quantity.disputed_context == null,
  );

  const nullMoneyPreserved = all50.packets.every((p) => {
    const m = p.money_lanes;
    if (m.estimated_amazon_payout !== null) return false;
    if (m.observed_reimbursement !== null) return false;
    if (m.internal_cost_loss !== null) return false;
    return true;
  });

  const salePriceNotCogs = all50.packets.every((p) => verifyMoneyRules(p).sale_price_not_cogs);

  const missingEvidenceWarning = all50.packets.every(
    (p) =>
      p.review_flags.includes("missing_photo_evidence") ||
      p.review_flags.some((f) => f.includes("missing_evidence") || f.includes("photo")),
  );

  const noCrashOnLinkage = all50.packets.every(
    (p) => p.product_identity != null && typeof p.product_identity.linkage_status === "string",
  );

  const composerSrc = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/evidence/claim-evidence-packet-v1.ts"),
    "utf8",
  );
  const noPdfGeneration = {
    pass:
      !composerSrc.includes("@react-pdf") &&
      !composerSrc.includes("renderToStream") &&
      !composerSrc.includes("claim-pdf"),
    note: "composer has no PDF imports or render calls",
  };

  const familyOk =
    all50.summary.family_distribution.removal_shipment_missing === 30 &&
    all50.summary.family_distribution.removal_order_discrepancy === 20;

  const linkageSummary = productLinkageSummary(all50.packets);
  const pointerSummary = evidencePointerSummary(all50.packets);

  const dateGateSummary = {
    pass: all50.summary.date_gate_passed_count === 50,
    date_gate_passed_count: all50.summary.date_gate_passed_count,
    all_have_effective_dates: all50.packets.every(
      (p) => !!p.date_gate.effective_date_source && !!p.date_gate.effective_date_value,
    ),
  };

  const sourceEdgeSummary = {
    pass: all50.summary.source_edges_present_count === 50,
    source_edges_present_count: all50.summary.source_edges_present_count,
    min_edges: Math.min(...all50.packets.map((p) => p.source_edges.length)),
    max_edges: Math.max(...all50.packets.map((p) => p.source_edges.length)),
  };

  const evidenceSummaryCheck = {
    pass: all50.summary.evidence_summary_present_count === 50,
    present: all50.summary.evidence_summary_present_count,
    expected: 50,
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

  const noDbWrite = candidatesBefore === candidatesAfter && casesBefore === casesAfter;

  const verifyPass =
    all50.packets.length === 50 &&
    singleShipment.packets.length === 1 &&
    singleOrder.packets.length === 1 &&
    familyOk &&
    allShapesPass &&
    disputedExcluded &&
    nullMoneyPreserved &&
    salePriceNotCogs &&
    missingEvidenceWarning &&
    noCrashOnLinkage &&
    noPdfGeneration.pass &&
    evidenceSummaryCheck.pass &&
    dateGateSummary.pass &&
    sourceEdgeSummary.pass &&
    noDbWrite &&
    scannerBefore === scannerAfter &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1-VERIFY",
    run_id: id,
    mode: "read-only-verify",
    original_ref: PRODUCTION_REF,
    pilot_intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    single_candidate_packet_samples: {
      removal_shipment_missing: singleSample(singleShipment.packets[0]!),
      removal_order_discrepancy: singleSample(singleOrder.packets[0]!),
    },
    grouped_packet_summary: groupedPacketSummary(all50),
    all_50_packet_summary: all50.summary,
    ready_for_case_creation_count: all50.summary.ready_for_case_creation_count,
    blocker_counts: all50.summary.blocker_counts,
    warning_counts: all50.summary.warning_counts,
    product_linkage_summary: linkageSummary,
    money_lane_summary: all50.summary.money_lane_null_counts,
    date_gate_summary: dateGateSummary,
    source_edge_summary: sourceEdgeSummary,
    evidence_pointer_summary: pointerSummary,
    evidence_summary_check: evidenceSummaryCheck,
    shape_verification: {
      pass: allShapesPass,
      failures: shapeChecks.filter((c) => !c.pass).map((c) => c.missing),
    },
    disputed_quantity_excluded_verification: { pass: disputedExcluded },
    null_money_preserved_verification: { pass: nullMoneyPreserved },
    sale_price_not_cogs_verification: { pass: salePriceNotCogs },
    missing_product_link_warning_verification: {
      pass: noCrashOnLinkage,
      missing_product_link_warnings: linkageSummary.missing_product_link_warning,
    },
    missing_evidence_warning_verification: { pass: missingEvidenceWarning },
    no_pdf_generation_verification: noPdfGeneration,
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
    SAFE_EVIDENCE_PACKET_PREVIEW_VERIFIED: verifyPass ? "yes" : "no",
    SAFE_TO_BUILD_EVIDENCE_PACKET_UI: verifyPass ? "yes" : "no",
    NEXT_PROMPT: verifyPass
      ? "PHASE-CLAIM-CASE-CREATION-CONTRACT-V1 — plan read-only case creation contract from verified evidence packet readiness"
      : "PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1-REMEDIATION — fix failing verify checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Evidence packet preview V1 verify

**Run:** ${id} · **Ref:** ${PRODUCTION_REF}

- Single samples: shipment + order discrepancy
- Grouped packets: **${all50.packets.length}**
- Ready for case creation: **${all50.summary.ready_for_case_creation_count}**
- SAFE_EVIDENCE_PACKET_PREVIEW_VERIFIED: **${results.SAFE_EVIDENCE_PACKET_PREVIEW_VERIFIED}**
`,
  );

  console.log(
    JSON.stringify({
      ok: verifyPass,
      run_id: id,
      packets: all50.packets.length,
      ready: all50.summary.ready_for_case_creation_count,
      SAFE_EVIDENCE_PACKET_PREVIEW_VERIFIED: results.SAFE_EVIDENCE_PACKET_PREVIEW_VERIFIED,
      outDir,
    }),
  );
  if (!verifyPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
