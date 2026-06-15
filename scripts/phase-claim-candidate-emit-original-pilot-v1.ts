/**
 * PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-V1 — original/live execute
 *   npx tsx scripts/phase-claim-candidate-emit-original-pilot-v1.ts --run-id=<UTC> [--dry-run] [--conservative]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

import {
  APPROVED_EMIT_V3_FAMILIES,
} from "../lib/claims/contracts/claim-candidate-emit-approval-contract-v1";
import { loadEffectiveClaimIntakePolicy } from "../lib/claims/intake/claim-intake-policy-contract";
import {
  countEligibleEmitPreviews,
  DEFAULT_ORIGINAL_CONSERVATIVE_CAP,
  DEFAULT_PILOT_MAX_ROWS,
  EMIT_ORIGIN_TAG,
  ORIGINAL_PILOT_REF,
  readOriginalPilotApprovalStatus,
  runClaimPreviewEmitOriginalPilotV1,
} from "../lib/claims/intake/claim-preview-emit-v1";
import { buildFirstSafeFamiliesPreviewGenerators } from "../lib/claims/center/claim-first-safe-families-preview-generators-v1";
import { bindProductionSupabaseEnv, productionPostgresUrl } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import pg from "pg";

const OUT = ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-v1";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
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

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

async function loadActiveApprovedDedupe(
  client: ReturnType<typeof createClient>,
): Promise<Set<string>> {
  const { data } = await client
    .from("claim_candidates")
    .select("dedupe_key, metadata, quarantined_at, rejected_at, source_kind")
    .eq("organization_id", ORG)
    .not("dedupe_key", "is", null)
    .is("quarantined_at", null)
    .is("rejected_at", null)
    .neq("source_kind", "legacy_seed");
  const keys = new Set<string>();
  for (const row of (data ?? []) as Array<{ dedupe_key: string | null; metadata: Record<string, unknown> | null }>) {
    if (!row.dedupe_key) continue;
    const fam = str(row.metadata?.family_key_v3);
    if ((APPROVED_EMIT_V3_FAMILIES as readonly string[]).includes(fam)) {
      keys.add(row.dedupe_key);
    }
  }
  return keys;
}

async function ensureOriginalEmitSchema(): Promise<{
  phase7b_applied: boolean;
  phase7b2_applied: boolean;
  had_dedupe_key: boolean;
  had_cogs_unit: boolean;
}> {
  const client = new pg.Client({ connectionString: productionPostgresUrl() });
  await client.connect();
  try {
    const col = await client.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'claim_candidates' AND column_name = 'dedupe_key'
        ) AS has_dedupe,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'claim_candidates' AND column_name = 'cogs_unit'
        ) AS has_cogs
    `);
    const hadDedupe = Boolean(col.rows[0]?.has_dedupe);
    const hadCogs = Boolean(col.rows[0]?.has_cogs);
    let phase7bApplied = false;
    let phase7b2Applied = false;
    if (!hadDedupe) {
      const sql = fs.readFileSync(
        path.join(
          process.cwd(),
          "supabase/migrations/20260914120000_phase7b_unified_claim_pool_schema_legacy_quarantine.sql",
        ),
        "utf8",
      );
      await client.query(sql);
      phase7bApplied = true;
    }
    if (!hadCogs) {
      const sql2 = fs.readFileSync(
        path.join(
          process.cwd(),
          "supabase/migrations/20260915120000_phase7b2_claim_pool_orbit_fra_extension.sql",
        ),
        "utf8",
      );
      await client.query(sql2);
      phase7b2Applied = true;
    }
    return {
      phase7b_applied: phase7bApplied,
      phase7b2_applied: phase7b2Applied,
      had_dedupe_key: hadDedupe,
      had_cogs_unit: hadCogs,
    };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const dryRun = process.argv.includes("--dry-run");
  const conservative = process.argv.includes("--conservative");

  if (process.env.STAGING_SUPABASE_URL?.includes(STAGING_REF) && !process.env.ORIGINAL_SUPABASE_URL) {
    throw new Error(`BLOCKED: bind original env — staging ref ${STAGING_REF} must not be emit target`);
  }

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== ORIGINAL_PILOT_REF) {
    throw new Error(`BLOCKED: expected original ref ${ORIGINAL_PILOT_REF}, got ${ref}`);
  }

  const schemaPreflight = await ensureOriginalEmitSchema();

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const approval = readOriginalPilotApprovalStatus();
  if (!approval.approved && !dryRun) {
    throw new Error(`BLOCKED: original approval required — ${approval.reason}`);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });

  const candidatesBefore = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;
  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const policy = await loadEffectiveClaimIntakePolicy(client, ORG, STORE);
  const activeDedupe = await loadActiveApprovedDedupe(client);

  const previewPayload = await buildFirstSafeFamiliesPreviewGenerators({
    client,
    organizationId: ORG,
    storeId: STORE,
    include_all_previews: true,
    rowLimit: 400,
    prerequisite_safe: "yes",
  });
  const claimReadyApproved = previewPayload.previews.filter(
    (p) =>
      (APPROVED_EMIT_V3_FAMILIES as readonly string[]).includes(p.family_key) &&
      p.recommended_action === "claim_ready",
  );
  const eligibleCounts = countEligibleEmitPreviews(claimReadyApproved, activeDedupe);

  const { data: legacyRows } = await client
    .from("claim_candidates")
    .select("id, candidate_status, quarantined_at, rejected_at, source_kind")
    .eq("organization_id", ORG)
    .or("quarantined_at.not.is.null,rejected_at.not.is.null,source_kind.eq.legacy_seed");

  const selectedCap = conservative
    ? DEFAULT_ORIGINAL_CONSERVATIVE_CAP
    : approval.max_rows_cap ?? DEFAULT_PILOT_MAX_ROWS;

  const scannerStatusBefore = scannerGitStatus();

  const beforeSnapshot = {
    claim_candidates_count: candidatesBefore ?? 0,
    claim_cases_count: casesBefore ?? 0,
    active_dedupe_approved_family: activeDedupe.size,
    eligible_preview_counts: eligibleCounts,
    policy_dates: {
      claim_start_date: policy.claim_start_date,
      scan_go_live_date: policy.scan_go_live_date,
      claim_eligibility_window_days: policy.claim_eligibility_window_days,
    },
    legacy_quarantined_rejected_count: (legacyRows ?? []).length,
    scanner_git_status_before: scannerStatusBefore,
    conservative_mode: conservative,
  };

  const result = await runClaimPreviewEmitOriginalPilotV1({
    client,
    organizationId: ORG,
    storeId: STORE,
    maxRows: selectedCap,
    dryRun,
    conservativeCap: conservative,
  });

  const scannerStatusAfter = scannerGitStatus();
  const noScannerChange = scannerStatusBefore === scannerStatusAfter;

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
    execSync(`npx tsx scripts/smoke-claim-candidate-emit-original-pilot-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const delta = result.after_count - result.before_count;

  const payload = {
    schema_preflight: schemaPreflight,
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-V1",
    run_id: id,
    dry_run: dryRun,
    conservative_mode: conservative,
    original_ref: ORIGINAL_PILOT_REF,
    original_ref_guard: result.original_ref_guard,
    approval_file_status: result.approval_file_status,
    approval_check: approval,
    intake_run_id: result.intake_run_id,
    selected_cap: result.selected_cap,
    before_snapshot: beforeSnapshot,
    eligible_preview_counts: result.eligible_preview_counts,
    inserted_count: result.inserted_count,
    updated_count: result.updated_count,
    skipped_count: result.skipped_count,
    emitted_family_counts: result.emitted_family_counts,
    removal_shipment_missing_count: result.removal_shipment_missing_count,
    removal_order_discrepancy_count: result.removal_order_discrepancy_count,
    skipped_reason_counts: result.skipped_reason_counts,
    sample_emitted_rows: result.sample_emitted_rows,
    date_gate_result: result.effective_date_gate_result,
    disputed_exclusion_result: result.disputed_exclusion_result,
    needs_review_exclusion_result: result.needs_review_exclusion_result,
    preview_only_family_exclusion_result: result.preview_only_family_exclusion_result,
    dedupe_result: result.dedupe_result,
    source_edge_result: result.source_edge_result,
    evidence_summary_result: result.evidence_summary_result,
    money_field_result: result.money_field_result,
    claim_cases_count_before_after: result.no_claim_case_mutation_verification,
    claim_candidates_count_before_after: {
      before: result.before_count,
      after: result.after_count,
      delta,
    },
    no_scanner_change_verification: noScannerChange ? "PASS" : "FAIL",
    rollback_sql: result.rollback_sql,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_ORIGINAL_EMIT_PILOT: result.SAFE_ORIGINAL_EMIT_PILOT,
    SAFE_TO_REVIEW_ORIGINAL_CANDIDATES_UI: result.SAFE_TO_REVIEW_ORIGINAL_CANDIDATES_UI,
    NEXT_PROMPT:
      "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-ROLLBACK-DRILL-V1 — quarantine original pilot intake_run_id; then review candidates in Claim Center UI",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback.sql"), result.rollback_sql);
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim candidate emit original pilot V1

**Run:** ${id} · **Dry-run:** ${dryRun} · **Conservative:** ${conservative}

- original ref: \`${ORIGINAL_PILOT_REF}\`
- cap: ${result.selected_cap} (shipment=${result.removal_shipment_missing_count} · order=${result.removal_order_discrepancy_count})
- before: ${result.before_count} → after: ${result.after_count} (Δ ${delta})
- inserted: ${result.inserted_count} · updated: ${result.updated_count}
- intake_run_id: \`${result.intake_run_id}\`
- claim_cases unchanged: ${result.no_claim_case_mutation_verification.pass ? "yes" : "no"}
- SAFE_ORIGINAL_EMIT_PILOT: ${result.SAFE_ORIGINAL_EMIT_PILOT}
- SAFE_TO_REVIEW_ORIGINAL_CANDIDATES_UI: ${result.SAFE_TO_REVIEW_ORIGINAL_CANDIDATES_UI}
`,
  );

  const pass =
    !dryRun &&
    approval.approved &&
    result.original_ref_guard.pass &&
    delta <= selectedCap &&
    result.effective_date_gate_result.pass &&
    result.no_claim_case_mutation_verification.pass &&
    result.disputed_exclusion_result.pass &&
    result.needs_review_exclusion_result.pass &&
    result.preview_only_family_exclusion_result.pass &&
    result.dedupe_result.pass &&
    result.source_edge_result.pass &&
    result.evidence_summary_result.pass &&
    result.removal_shipment_missing_count > 0 &&
    result.removal_order_discrepancy_count > 0 &&
    buildResult === "pass" &&
    smokeResult === "pass" &&
    noScannerChange &&
    result.SAFE_ORIGINAL_EMIT_PILOT === "yes";

  console.log(
    JSON.stringify({
      ok: pass,
      run_id: id,
      delta,
      inserted: result.inserted_count,
      updated: result.updated_count,
      shipment_missing: result.removal_shipment_missing_count,
      order_discrepancy: result.removal_order_discrepancy_count,
      intake_run_id: result.intake_run_id,
      SAFE_ORIGINAL_EMIT_PILOT: result.SAFE_ORIGINAL_EMIT_PILOT,
      outDir,
    }),
  );
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
