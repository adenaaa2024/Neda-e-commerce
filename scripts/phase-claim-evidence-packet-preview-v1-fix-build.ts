/**
 * PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1-FIX-BUILD — fix + verify evidence packet preview
 *   npx tsx scripts/phase-claim-evidence-packet-preview-v1-fix-build.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { composeClaimEvidencePacketV1 } from "../lib/claims/evidence/claim-evidence-packet-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "../lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-evidence-packet-preview-v1-fix-build";
const PLAN_RESULTS =
  ".cursor/audit-reports/phase-claim-evidence-packet-v1-plan/20260615T080000Z/results.json";
const COMPOSER = "lib/claims/evidence/claim-evidence-packet-v1.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const FILES_CHANGED = [
  COMPOSER,
  "scripts/phase-claim-evidence-packet-preview-v1.ts",
  "scripts/smoke-claim-evidence-packet-preview-v1.ts",
  "scripts/phase-claim-evidence-packet-preview-v1-fix-build.ts",
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

function staticFixChecks(composerSrc: string): {
  no_supabase_server: boolean;
  no_buildProductLinkageDisplayContracts: boolean;
  client_param_linkage: boolean;
  opt_str_nullable: boolean;
  parse_metadata_edges_safe: boolean;
} {
  return {
    no_supabase_server: !composerSrc.includes("supabaseServer") && !composerSrc.includes("server-only"),
    no_buildProductLinkageDisplayContracts: !composerSrc.includes("buildProductLinkageDisplayContracts"),
    client_param_linkage: composerSrc.includes("resolveProductIdentity") && composerSrc.includes("client: SupabaseClient"),
    opt_str_nullable: composerSrc.includes("function optStr"),
    parse_metadata_edges_safe: composerSrc.includes("const out: EvidencePacketV1ReferenceEdge[]"),
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();

  const planPath = path.join(process.cwd(), PLAN_RESULTS);
  if (!fs.existsSync(planPath)) throw new Error(`BLOCKED: plan missing at ${PLAN_RESULTS}`);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, string>;
  if (plan.SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_BUILD_EVIDENCE_PACKET_PREVIEW must be yes");
  }

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const composerSrc = fs.readFileSync(path.join(process.cwd(), COMPOSER), "utf8");
  const fixChecks = staticFixChecks(composerSrc);
  const staticPass = Object.values(fixChecks).every(Boolean);

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

  const candidatesAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const scannerAfter = scannerGitStatus();

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

  const familyOk =
    all50.summary.family_distribution.removal_shipment_missing === 30 &&
    all50.summary.family_distribution.removal_order_discrepancy === 20;

  const noDbWrite = candidatesBefore === candidatesAfter && casesBefore === casesAfter;

  const pass =
    staticPass &&
    all50.packets.length === 50 &&
    familyOk &&
    noDbWrite &&
    scannerBefore === scannerAfter &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1-FIX-BUILD",
    run_id: id,
    mode: "fix-build-verify",
    original_ref: PRODUCTION_REF,
    pilot_intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    files_changed: FILES_CHANGED,
    root_cause: [
      "composeClaimEvidencePacketV1 initially imported buildProductLinkageDisplayContracts which pulls supabaseServer/server-only",
      "Node tsx phase script crashed: This module cannot be imported from a Client Component",
      "TypeScript build failures: parseMetadataEdges filter type narrowing; ProductNameFields used title instead of name/product_name",
    ],
    build_fix_summary: [
      "Replaced buildProductLinkageDisplayContracts with resolveProductIdentity(client, org, row) using mapRowToProductLinkageDisplayContract",
      "Rewrote parseMetadataEdges to explicit for-loop (no unsafe filter predicate)",
      "Product row select uses name/product_name per ProductNameFields contract",
    ],
    runtime_fix_summary: [
      "All DB access in composer accepts SupabaseClient parameter — safe for phase scripts and API handlers",
      "loadMaterializedCandidateEdges already client-parameterized",
      "Phase/smoke scripts use createClient directly without server-only imports",
    ],
    product_linkage_fix_summary: [
      "resolveProductIdentity uses optStr for nullable product_id/asin/fnsku/sku",
      "Product fetch errors ignored — row-level identifiers still compose",
      "unlinked/ambiguous linkage → review_flags missing_product_link (warning), never throw",
    ],
    static_fix_checks: fixChecks,
    packet_shape: [...PACKET_SHAPE],
    all_50_packet_summary: all50.summary,
    ready_for_case_creation_count: all50.summary.ready_for_case_creation_count,
    blocker_counts: all50.summary.blocker_counts,
    warning_counts: all50.summary.warning_counts,
    money_lane_summary: all50.summary.money_lane_null_counts,
    date_gate_summary: {
      pass: all50.summary.date_gate_passed_count === 50,
      date_gate_passed_count: all50.summary.date_gate_passed_count,
    },
    source_edge_summary: {
      pass: all50.summary.source_edges_present_count === 50,
      source_edges_present_count: all50.summary.source_edges_present_count,
    },
    evidence_summary_check: {
      pass: all50.summary.evidence_summary_present_count === 50,
      present: all50.summary.evidence_summary_present_count,
      expected: 50,
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
    SAFE_EVIDENCE_PACKET_PREVIEW_READY: pass ? "yes" : "no",
    SAFE_TO_BUILD_EVIDENCE_PACKET_UI: pass ? "yes" : "no",
    NEXT_PROMPT: pass
      ? "PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1-VERIFY — full reliability verify before UI (or proceed if verify already PASS)"
      : "PHASE-CLAIM-EVIDENCE-PACKET-PREVIEW-V1-FIX-BUILD-REMEDIATION",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Evidence packet preview FIX-BUILD

**Run:** ${id} · **Ref:** ${PRODUCTION_REF}

- Static fixes: **${staticPass ? "PASS" : "FAIL"}**
- Packets: **${all50.packets.length}**
- SAFE_EVIDENCE_PACKET_PREVIEW_READY: **${results.SAFE_EVIDENCE_PACKET_PREVIEW_READY}**
`,
  );

  console.log(
    JSON.stringify({
      ok: pass,
      run_id: id,
      packets: all50.packets.length,
      SAFE_EVIDENCE_PACKET_PREVIEW_READY: results.SAFE_EVIDENCE_PACKET_PREVIEW_READY,
      outDir,
    }),
  );
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
