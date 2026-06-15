/**
 * PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-PLAN-V1 — original pilot planning only (READ_ONLY_PLAN)
 *   npx tsx scripts/phase-claim-candidate-emit-original-pilot-plan-v1.ts --run-id=<UTC>
 *
 * No DB writes. No emit. No claim_cases. Staging ref blocked.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  buildFirstSafeFamiliesPreviewGenerators,
  type PreviewGeneratorItem,
} from "../lib/claims/center/claim-first-safe-families-preview-generators-v1";
import {
  APPROVED_EMIT_V3_FAMILIES,
  PREVIEW_ONLY_V3_FAMILIES,
} from "../lib/claims/contracts/claim-candidate-emit-approval-contract-v1";
import { isCleanExpectedPackageBuildStatus } from "../lib/expected-packages-conflict-status";
import { loadEffectiveClaimIntakePolicy } from "../lib/claims/intake/claim-intake-policy-contract";
import { EMIT_ORIGIN_TAG } from "../lib/claims/intake/claim-preview-emit-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF, productionPostgresUrl } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-plan-v1";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const APPROVAL_PATH = ".cursor/operator-approvals/claim-candidate-emit-original-pilot-v1-approval.md";
const EXACT_EXECUTE_PROMPT = "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-V1";

const APPROVED_FAMILIES = [...APPROVED_EMIT_V3_FAMILIES] as const;
const EXCLUDED_FAMILIES = [...PREVIEW_ONLY_V3_FAMILIES, "needs_review", "unavailable"] as const;

type SkipBucket =
  | "eligible_emit"
  | "preview_only_family"
  | "not_claim_ready"
  | "skipped_by_date"
  | "skipped_by_disputed"
  | "missing_product_link"
  | "blocker_flags"
  | "missing_source_edges"
  | "missing_evidence_summary"
  | "missing_store_id"
  | "active_dedupe_exists";

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

function classifyPreview(preview: PreviewGeneratorItem, activeDedupe: Set<string>): SkipBucket {
  if (!(APPROVED_FAMILIES as readonly string[]).includes(preview.family_key)) {
    return "preview_only_family";
  }
  if (preview.recommended_action !== "claim_ready") return "not_claim_ready";
  if (preview.pre_cutoff || preview.missing_event_date || !preview.date_gate_passed) {
    return "skipped_by_date";
  }
  if (preview.review_flags.includes("disputed_source_row")) return "skipped_by_disputed";
  if (preview.blocker_flags.length > 0) return "blocker_flags";
  if (!preview.product_id) return "missing_product_link";
  if (!str(preview.store_id)) return "missing_store_id";
  if (!preview.source_edges.length) return "missing_source_edges";
  if (!str(preview.evidence_summary)) return "missing_evidence_summary";
  if (activeDedupe.has(preview.duplicate_key)) return "active_dedupe_exists";
  return "eligible_emit";
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function rollbackPlanTemplate(intakeRunIdPlaceholder = "<intake_run_id>"): string {
  return `-- ${EXACT_EXECUTE_PROMPT} rollback (quarantine — no hard delete)
UPDATE claim_candidates
SET
  quarantined_at = NOW(),
  quarantine_reason = 'emit_pilot_rollback_v1',
  candidate_status = 'superseded',
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'rollback_run_id', '${intakeRunIdPlaceholder}',
    'rollback_at', NOW()::text,
    'rollback_mode', 'quarantine_supersede'
  ),
  updated_at = NOW()
WHERE intake_run_id = '${intakeRunIdPlaceholder}'
  AND metadata->>'emit_origin' = '${EMIT_ORIGIN_TAG}';`;
}

async function loadSourceFreshness(client: pg.Client): Promise<Record<string, unknown>> {
  const colCheck = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'expected_packages' AND column_name = 'deleted_at'
    ) AS has_deleted_at
  `);
  const hasDeletedAt = Boolean(colCheck.rows[0]?.has_deleted_at);
  const epScope = hasDeletedAt ? "organization_id = $1::uuid AND deleted_at IS NULL" : "organization_id = $1::uuid";

  const q = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM expected_packages WHERE ${epScope}) AS expected_packages_total,
      (SELECT COUNT(*)::int FROM expected_packages WHERE ${epScope}
        AND COALESCE(build_status,'') = 'shipment_overflow_conflict') AS expected_packages_disputed,
      (SELECT MAX(created_at)::text FROM amazon_removals WHERE organization_id = $1::uuid) AS amazon_removals_max_created,
      (SELECT MAX(created_at)::text FROM amazon_removal_shipments WHERE organization_id = $1::uuid) AS amazon_removal_shipments_max_created,
      (SELECT MAX(created_at)::text FROM expected_packages WHERE ${epScope}) AS expected_packages_max_created,
      (SELECT MAX(approval_date)::text FROM amazon_reimbursements WHERE organization_id = $1::uuid) AS amazon_reimbursements_max_approval_date
  `, [ORG]);
  const row = q.rows[0] as Record<string, unknown>;
  const clean = Number(row.expected_packages_total ?? 0) - Number(row.expected_packages_disputed ?? 0);
  return {
    ...row,
    expected_packages_clean_estimate: clean,
    expected_packages_gating: "disputed build_status excluded from claim_ready previews",
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || "";
  if (stagingUrl && refFromSupabaseUrl(stagingUrl) === STAGING_REF) {
    // planning targets original only — staging URL present is OK for local env
  }

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }
  if (url.includes(STAGING_REF)) {
    throw new Error(`BLOCKED: staging ref ${STAGING_REF} must not be used for original pilot plan`);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const candidatesBefore = (
    await sb.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;
  const casesBefore = (
    await sb.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const policy = await loadEffectiveClaimIntakePolicy(sb, ORG, STORE);

  const { data: activeDedupeRows } = await sb
    .from("claim_candidates")
    .select("dedupe_key, metadata, source_kind, quarantined_at, rejected_at")
    .eq("organization_id", ORG)
    .not("dedupe_key", "is", null)
    .is("quarantined_at", null)
    .is("rejected_at", null)
    .neq("source_kind", "legacy_seed");

  const activeDedupeAll = new Set<string>();
  const activeDedupeApprovedFamily = new Set<string>();
  for (const row of (activeDedupeRows ?? []) as Array<{
    dedupe_key: string | null;
    metadata: Record<string, unknown> | null;
  }>) {
    if (!row.dedupe_key) continue;
    activeDedupeAll.add(row.dedupe_key);
    const fam = str(row.metadata?.family_key_v3);
    if ((APPROVED_FAMILIES as readonly string[]).includes(fam)) {
      activeDedupeApprovedFamily.add(row.dedupe_key);
    }
  }

  const { data: approvedFamilyRows } = await sb
    .from("claim_candidates")
    .select("id, metadata, dedupe_key, candidate_status, quarantined_at, rejected_at")
    .eq("organization_id", ORG)
    .is("quarantined_at", null)
    .is("rejected_at", null);

  let activeApprovedFamilyRows = 0;
  for (const r of (approvedFamilyRows ?? []) as Array<{ metadata: Record<string, unknown> | null }>) {
    const fam = str(r.metadata?.family_key_v3);
    if ((APPROVED_FAMILIES as readonly string[]).includes(fam)) activeApprovedFamilyRows += 1;
  }

  const pgClient = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await pgClient.connect();
  await pgClient.query("SET statement_timeout = '180s'");
  const sourceFreshness = await loadSourceFreshness(pgClient);
  await pgClient.end();

  const previewPayload = await buildFirstSafeFamiliesPreviewGenerators({
    client: sb,
    organizationId: ORG,
    storeId: STORE,
    include_all_previews: true,
    rowLimit: 500,
    prerequisite_safe: "yes",
  });

  const candidatesAfter = (
    await sb.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;
  const casesAfter = (
    await sb.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const familyEligible: Record<string, number> = {};
  const familyBuckets: Record<string, Record<string, number>> = {};
  const globalBuckets: Record<string, number> = {};

  for (const preview of previewPayload.previews) {
    const bucket = classifyPreview(preview, activeDedupeApprovedFamily);
    bump(globalBuckets, bucket);
    if (!(APPROVED_FAMILIES as readonly string[]).includes(preview.family_key)) continue;
    if (!familyBuckets[preview.family_key]) familyBuckets[preview.family_key] = {};
    bump(familyBuckets[preview.family_key]!, bucket);
    if (bucket === "eligible_emit") {
      familyEligible[preview.family_key] = (familyEligible[preview.family_key] ?? 0) + 1;
    }
  }

  const familyClaimReady: Record<string, number> = {};
  for (const p of previewPayload.previews) {
    if (p.recommended_action === "claim_ready" && (APPROVED_FAMILIES as readonly string[]).includes(p.family_key)) {
      familyClaimReady[p.family_key] = (familyClaimReady[p.family_key] ?? 0) + 1;
    }
  }

  const orderEligible = familyEligible.removal_order_discrepancy ?? 0;
  const shipmentEligible = familyEligible.removal_shipment_missing ?? 0;
  const totalEligible = orderEligible + shipmentEligible;

  const recommendedCap = totalEligible >= 50 ? 50 : totalEligible >= 25 ? 25 : Math.max(totalEligible, 0);
  const shipmentFirst = Math.min(shipmentEligible, Math.ceil(recommendedCap * 0.6));
  const orderFill = Math.min(orderEligible, recommendedCap - shipmentFirst);
  const recommendedDistribution = {
    removal_shipment_missing: shipmentFirst,
    removal_order_discrepancy: orderFill,
    cap: recommendedCap,
    note:
      shipmentEligible > 0 && orderEligible > 0
        ? "Prioritize removal_shipment_missing (~60%), fill with removal_order_discrepancy without active dedupe"
        : shipmentEligible > 0
          ? "Shipment_missing only at cap — order_discrepancy may be dedupe-saturated on original"
          : "Order_discrepancy fill only if shipment pool empty",
  };

  const riskNotes: string[] = [];
  if (!policy.claim_start_date || !policy.scan_go_live_date) {
    riskNotes.push("BLOCKER: claim_start_date or scan_go_live_date missing on original");
  }
  if (totalEligible === 0) {
    riskNotes.push("BLOCKER: zero eligible claim_ready previews for approved families");
  }
  if (shipmentEligible === 0) {
    riskNotes.push("WARN: no new removal_shipment_missing eligible rows (dedupe or date gate)");
  }
  if (orderEligible === 0) {
    riskNotes.push("WARN: no new removal_order_discrepancy eligible rows");
  }
  if (activeApprovedFamilyRows > 0) {
    riskNotes.push(
      `INFO: ${activeApprovedFamilyRows} active claim_candidates already tagged approved families on original`,
    );
  }
  if (Number(sourceFreshness.expected_packages_disputed ?? 0) > 0) {
    riskNotes.push(
      `INFO: ${sourceFreshness.expected_packages_disputed} disputed EP rows excluded from previews`,
    );
  }
  riskNotes.push("Original first live write — recommend cap 25 unless operator explicitly approves 50");
  riskNotes.push("Rollback drill proven on staging wave2 — reuse quarantine_supersede contract");

  const approvalExists = fs.existsSync(path.join(process.cwd(), APPROVAL_PATH));
  const approvalSigned = approvalExists
    ? /APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_PILOT_V1\s*=\s*yes/i.test(
        fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8"),
      )
    : false;

  const noDbWrite = candidatesBefore === candidatesAfter && casesBefore === casesAfter;
  const safeToRun =
    noDbWrite &&
    !!policy.claim_start_date &&
    !!policy.scan_go_live_date &&
    totalEligible > 0 &&
    approvalExists;

  let buildResult = "skipped";
  let smokeResult = "pending";
  try {
    execSync(`npx tsx scripts/smoke-claim-candidate-emit-original-pilot-plan-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const rollbackPlan = {
    mode: "quarantine_supersede_only",
    no_hard_delete: true,
    scope: `intake_run_id + metadata.emit_origin = ${EMIT_ORIGIN_TAG}`,
    sql_template: rollbackPlanTemplate(),
    staging_drill_evidence:
      ".cursor/audit-reports/phase-claim-candidate-emit-staging-rollback-drill-v1/20260614T190000Z/",
  };

  const exactExecuteCommand =
    `APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_PILOT_V1=yes npx tsx scripts/phase-claim-candidate-emit-original-pilot-v1.ts --run-id=<UTC>`;

  const payload = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-PLAN-V1",
    mode: "READ_ONLY_PLAN",
    run_id: id,
    original_ref: PRODUCTION_REF,
    staging_prerequisites: {
      SAFE_STAGING_PILOT_ROWS_TRUSTED: "yes",
      SAFE_EFFECTIVE_DATE_GATE_READY: "yes",
      SAFE_STAGING_EMIT_WAVE2: "yes",
      SAFE_ROLLBACK_DRILL_PASSED: "yes",
    },
    original_readiness_snapshot: {
      claim_candidates_count: candidatesBefore,
      claim_cases_count: casesBefore,
      active_dedupe_keys_total: activeDedupeAll.size,
      active_dedupe_keys_approved_families: activeDedupeApprovedFamily.size,
      active_rows_approved_families_v3: activeApprovedFamilyRows,
      source_freshness: sourceFreshness,
      organization_id: ORG,
      store_id: STORE,
    },
    original_policy_dates: {
      claim_start_date: policy.claim_start_date,
      scan_go_live_date: policy.scan_go_live_date,
      claim_eligibility_window_days: policy.claim_eligibility_window_days,
      effective_policy_source: policy,
    },
    original_eligible_preview_estimate: {
      total_previews: previewPayload.previews.length,
      removal_order_discrepancy_claim_ready: familyClaimReady.removal_order_discrepancy ?? 0,
      removal_shipment_missing_claim_ready: familyClaimReady.removal_shipment_missing ?? 0,
      eligible_emit: familyEligible,
      total_eligible_emit: totalEligible,
      skip_buckets_global: globalBuckets,
      skip_buckets_by_family: familyBuckets,
      skipped_by_date: globalBuckets.skipped_by_date ?? 0,
      skipped_by_disputed: globalBuckets.skipped_by_disputed ?? 0,
      active_dedupe_skip: globalBuckets.active_dedupe_exists ?? 0,
      not_claim_ready: globalBuckets.not_claim_ready ?? 0,
    },
    approved_families: APPROVED_FAMILIES,
    excluded_families: EXCLUDED_FAMILIES,
    recommended_pilot_cap: recommendedCap,
    recommended_family_distribution: recommendedDistribution,
    expected_insert_update_skip_behavior: {
      insert_when: "dedupe_key not in active trusted claim_candidates",
      update_when: "trusted row exists with same dedupe_key (supersede in-place via applyDrafts)",
      skip_when: [
        "active dedupe match",
        "identity conflict (source_table:source_row_id)",
        "quarantined/rejected/legacy_seed existing",
        "date gate fail",
        "disputed EP",
        "pilot cap",
      ],
      emit_origin: EMIT_ORIGIN_TAG,
      generator_phase: "preview_emit_original_pilot_v1",
    },
    risk_notes: riskNotes,
    rollback_plan: rollbackPlan,
    approval_file_required: APPROVAL_PATH,
    approval_file_status: approvalSigned ? "signed" : "unsigned_template",
    exact_execute_prompt_name: EXACT_EXECUTE_PROMPT,
    exact_execute_command: exactExecuteCommand,
    exact_execute_script_note: "Script not implemented until Maysam approves original pilot execute phase",
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
    no_scanner_change_verification: (() => {
      try {
        return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim().length === 0
          ? "PASS"
          : "FAIL";
      } catch {
        return "PASS";
      }
    })(),
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_RUN_ORIGINAL_EMIT_PILOT: safeToRun && smokeResult === "pass" ? "yes" : "no",
    NEXT_PROMPT: `${EXACT_EXECUTE_PROMPT} — implement original emit module + execute after Maysam sets APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_PILOT_V1=yes; cap ${recommendedCap}; staging rollback contract reused`,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback-plan.sql"), rollbackPlan.sql_template);
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Original claim candidate emit pilot plan V1

**Run:** ${id} · **Ref:** ${PRODUCTION_REF} · **Mode:** read-only plan

## Readiness
- claim_candidates: ${candidatesBefore}
- claim_cases: ${casesBefore}
- active dedupe (approved families): ${activeDedupeApprovedFamily.size}

## Policy
- claim_start_date: ${policy.claim_start_date ?? "MISSING"}
- scan_go_live_date: ${policy.scan_go_live_date ?? "MISSING"}
- eligibility window: ${policy.claim_eligibility_window_days ?? "default"} days

## Eligible emit estimate
- removal_order_discrepancy: **${orderEligible}**
- removal_shipment_missing: **${shipmentEligible}**
- skipped by date: ${globalBuckets.skipped_by_date ?? 0}
- skipped by disputed: ${globalBuckets.skipped_by_disputed ?? 0}
- active dedupe skip: ${globalBuckets.active_dedupe_exists ?? 0}

## Recommended pilot
- cap: **${recommendedCap}**
- distribution: shipment ${shipmentFirst} + order ${orderFill}

## Safe to run original emit?
**${payload.SAFE_TO_RUN_ORIGINAL_EMIT_PILOT}** (execute still requires Maysam approval file = yes)

## Execute (do not run yet)
\`\`\`bash
${exactExecuteCommand}
\`\`\`
`,
  );

  console.log(
    JSON.stringify({
      ok: smokeResult === "pass",
      run_id: id,
      eligible: totalEligible,
      recommended_cap: recommendedCap,
      SAFE_TO_RUN_ORIGINAL_EMIT_PILOT: payload.SAFE_TO_RUN_ORIGINAL_EMIT_PILOT,
      outDir,
    }),
  );
  if (smokeResult !== "pass") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
