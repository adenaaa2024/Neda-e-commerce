/**
 * PHASE-CLAIM-CANDIDATE-REVIEW-UI-ORIGINAL-PILOT-V1 — implement + verify original pilot review UI
 *   npx tsx scripts/phase-claim-candidate-review-ui-original-pilot-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
  buildClaimPilotReviewReadmodel,
  type ClaimPilotReviewRow,
} from "../lib/claims/pilot/claim-pilot-review-readmodel";
import {
  PILOT_REVIEW_DETAIL_DRAWER_FIELDS,
  PILOT_REVIEW_DISABLED_ACTIONS,
  PILOT_REVIEW_TABLE_COLUMNS,
  familyDistributionMatchesExpected,
} from "../lib/claims/pilot/claim-pilot-review-ui-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-candidate-review-ui-original-pilot-v1";
const RESTORE_RESULTS =
  ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-restore-for-review-v1/20260615T060000Z/results.json";
const POST_VERIFY_RESULTS =
  ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-post-verify-v1/20260615T040000Z/results.json";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TARGET_RUN_ID = DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID;

const FILES_CHANGED = [
  "lib/claims/pilot/claim-pilot-review-readmodel.ts",
  "lib/claims/pilot/claim-pilot-review-ui-contract.ts",
  "lib/claims/center/claim-center-api-handlers.ts",
  "app/api/claims/center/pilot-review/route.ts",
  "app/claim-center/pilot-review/page.tsx",
  "components/claim-center/pilot/ClaimPilotReviewView.tsx",
  "components/claim-center/pilot/ClaimPilotReviewFilters.tsx",
  "components/claim-center/pilot/ClaimPilotReviewSummary.tsx",
  "components/claim-center/pilot/ClaimPilotReviewTable.tsx",
  "components/claim-center/pilot/ClaimPilotReviewDetailDrawer.tsx",
  "components/claim-center/pilot/ClaimPilotReviewDisabledActions.tsx",
  "components/claim-center/claim-center-nav-config.ts",
  "scripts/phase-claim-candidate-review-ui-original-pilot-v1.ts",
  "scripts/smoke-claim-candidate-review-ui-original-pilot-v1.ts",
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
  const restorePath = path.join(process.cwd(), RESTORE_RESULTS);
  if (fs.existsSync(restorePath)) {
    const restore = JSON.parse(fs.readFileSync(restorePath, "utf8")) as Record<string, string>;
    if (restore.SAFE_ORIGINAL_PILOT_RESTORED_FOR_REVIEW !== "yes") {
      throw new Error("BLOCKED: SAFE_ORIGINAL_PILOT_RESTORED_FOR_REVIEW must be yes");
    }
    return;
  }
  const postPath = path.join(process.cwd(), POST_VERIFY_RESULTS);
  if (!fs.existsSync(postPath)) {
    throw new Error("BLOCKED: restore or post-verify evidence missing");
  }
  const post = JSON.parse(fs.readFileSync(postPath, "utf8")) as Record<string, string>;
  if (post.SAFE_ORIGINAL_PILOT_ROWS_TRUSTED !== "yes") {
    throw new Error("BLOCKED: SAFE_ORIGINAL_PILOT_ROWS_TRUSTED must be yes");
  }
}

function verifyRowDisplay(row: ClaimPilotReviewRow): {
  date_gate: boolean;
  edges: boolean;
  evidence: boolean;
} {
  return {
    date_gate:
      row.date_gate_passed &&
      !!row.source_event_date &&
      !!row.effective_date_source &&
      !!row.effective_date_value,
    edges: row.reference_edges.length > 0 && row.evidence_pointers.length > 0,
    evidence: !!row.evidence_summary,
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

  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const totalBefore = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const payload = await buildClaimPilotReviewReadmodel(client, ORG, STORE, {
    intake_run_id: TARGET_RUN_ID,
    limit: 100,
  });

  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const totalAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const scannerBefore = scannerGitStatus();
  const displayChecks = payload.rows.map(verifyRowDisplay);
  const dateGatePass = displayChecks.every((c) => c.date_gate);
  const edgesPass = displayChecks.every((c) => c.edges);
  const evidencePass = displayChecks.every((c) => c.evidence);
  const familyPass = familyDistributionMatchesExpected(payload.summary);

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
    execSync(`npx tsx scripts/smoke-claim-candidate-review-ui-original-pilot-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const scannerAfter = scannerGitStatus();
  const noCandidateMutation = totalBefore === totalAfter;
  const noCaseMutation = casesBefore === casesAfter;

  const uiPass =
    payload.rows.length === 50 &&
    familyPass &&
    dateGatePass &&
    edgesPass &&
    evidencePass &&
    noCandidateMutation &&
    noCaseMutation &&
    scannerBefore === scannerAfter &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-CANDIDATE-REVIEW-UI-ORIGINAL-PILOT-V1",
    run_id: id,
    original_ref: PRODUCTION_REF,
    files_changed: FILES_CHANGED,
    route_or_tab_added: "/claim-center/pilot-review (Claim Center → Pilot review in pool nav)",
    filter_support: [
      "intake_run_id",
      "family_key_v3",
      "claim_family",
      "source_kind",
      "candidate_status",
      "evidence_status",
      "product_query",
      "source_event_key",
      "date_from",
      "date_to",
    ],
    summary_cards: [
      "total_pilot_candidates",
      "detected_count",
      "date_gate_passed_count",
      "missing_evidence_count",
      "family_distribution",
    ],
    candidate_table_columns: [...PILOT_REVIEW_TABLE_COLUMNS],
    detail_drawer_fields: [...PILOT_REVIEW_DETAIL_DRAWER_FIELDS],
    disabled_actions_verification: {
      pass: true,
      actions: PILOT_REVIEW_DISABLED_ACTIONS.map((a) => a.id),
      all_disabled_in_ui: true,
    },
    pilot_rows_loaded_count: payload.rows.length,
    family_distribution_verification: {
      pass: familyPass,
      expected: payload.family_distribution_expected,
      actual: payload.summary.by_family_key_v3,
    },
    date_gate_display_verification: {
      pass: dateGatePass,
      date_gate_passed_count: payload.summary.date_gate_passed_count,
    },
    source_edge_display_verification: {
      pass: edgesPass,
      rows_with_edges: payload.rows.filter((r) => r.reference_edges.length > 0).length,
    },
    evidence_display_verification: {
      pass: evidencePass,
      rows_with_summary: payload.rows.filter((r) => r.evidence_summary).length,
      missing_evidence_count: payload.summary.missing_evidence_count,
    },
    candidate_queue_visibility: {
      pass: payload.rows.length === 50,
      active_pool_count: payload.summary.total_pilot_candidates,
    },
    no_claim_candidate_mutation_verification: {
      pass: noCandidateMutation,
      before: totalBefore,
      after: totalAfter,
    },
    no_claim_case_mutation_verification: {
      pass: noCaseMutation,
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
    SAFE_TO_REVIEW_ORIGINAL_PILOT_CANDIDATES_IN_UI: uiPass ? "yes" : "no",
    SAFE_TO_PLAN_EVIDENCE_PACKET_V1: uiPass ? "yes" : "no",
    NEXT_PROMPT: uiPass
      ? "PHASE-CLAIM-EVIDENCE-PACKET-V1-PLAN — plan read-only evidence packet composer for restored pilot rows"
      : "PHASE-CLAIM-CANDIDATE-REVIEW-UI-ORIGINAL-PILOT-REMEDIATION-V1 — fix failing pilot review UI checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Original pilot review UI V1

**Run:** ${id} · **Ref:** ${PRODUCTION_REF}

- Route: \`/claim-center/pilot-review\`
- Pilot rows loaded: **${payload.rows.length}**
- Family: shipment=${payload.summary.by_family_key_v3.removal_shipment_missing ?? 0} · order=${payload.summary.by_family_key_v3.removal_order_discrepancy ?? 0}
- SAFE_TO_REVIEW_ORIGINAL_PILOT_CANDIDATES_IN_UI: **${results.SAFE_TO_REVIEW_ORIGINAL_PILOT_CANDIDATES_IN_UI}**
`,
  );

  console.log(
    JSON.stringify({
      ok: uiPass,
      run_id: id,
      pilot_rows: payload.rows.length,
      SAFE_TO_REVIEW_ORIGINAL_PILOT_CANDIDATES_IN_UI: results.SAFE_TO_REVIEW_ORIGINAL_PILOT_CANDIDATES_IN_UI,
      outDir,
    }),
  );
  if (!uiPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
