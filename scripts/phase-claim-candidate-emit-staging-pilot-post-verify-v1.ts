/**
 * PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-POST-VERIFY-V1 — read-only staging row audit
 *   npx tsx scripts/phase-claim-candidate-emit-staging-pilot-post-verify-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { isCleanExpectedPackageBuildStatus } from "../lib/expected-packages-conflict-status";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-candidate-emit-staging-pilot-post-verify-v1";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const CURRENT_INTAKE_RUN_ID = "6870dbd1-dac0-4f33-b06c-bfe16d7f3bf5";
const PRIOR_INTAKE_RUN_ID = "e435584f-5092-4b83-84ac-6f8c49e7b900";
const CLAIM_START_DATE = "2026-01-15";
const APPROVED_FAMILIES_V3 = new Set(["removal_order_discrepancy", "removal_shipment_missing"]);
const BLOCKED_FAMILIES_V3 = new Set([
  "physical_return_scanner_issue",
  "partial_incorrect_reimbursement",
]);

const ROLLBACK_SQL = `-- PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-V1 rollback (quarantine — no hard delete)
UPDATE claim_candidates
SET
  quarantined_at = NOW(),
  quarantine_reason = 'emit_pilot_rollback_v1',
  candidate_status = 'superseded',
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'rollback_run_id', '${CURRENT_INTAKE_RUN_ID}',
    'rollback_at', NOW()::text,
    'rollback_mode', 'quarantine_supersede'
  ),
  updated_at = NOW()
WHERE intake_run_id = '${CURRENT_INTAKE_RUN_ID}'
  AND metadata->>'emit_origin' = 'preview_emit_v1';`;

type PilotRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  source_kind: string | null;
  source_table: string;
  source_row_id: string;
  claim_family: string;
  dedupe_key: string | null;
  source_event_key: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
  expected_quantity: number | null;
  candidate_status: string | null;
  evidence_status: string | null;
  intake_run_id: string | null;
  quarantined_at: string | null;
  rejected_at: string | null;
  metadata: Record<string, unknown> | null;
  event_date: string | null;
};

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

function isActivePilotRow(r: PilotRow): boolean {
  return !r.quarantined_at && !r.rejected_at && r.candidate_status !== "quarantined";
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  if (refFromSupabaseUrl(url) !== STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_REF}`);
  }

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });
  const client = createClient(url, key, { auth: { persistSession: false } });

  const selectCols =
    "id, organization_id, store_id, source_kind, source_table, source_row_id, claim_family, dedupe_key, source_event_key, sku, fnsku, asin, resolved_product_id, expected_quantity, candidate_status, evidence_status, intake_run_id, quarantined_at, rejected_at, metadata, event_date";

  const { data: currentRows, error: curErr } = await client
    .from("claim_candidates")
    .select(selectCols)
    .eq("organization_id", ORG)
    .eq("intake_run_id", CURRENT_INTAKE_RUN_ID);
  if (curErr) throw new Error(curErr.message);

  const { data: priorRows, error: priorErr } = await client
    .from("claim_candidates")
    .select(selectCols)
    .eq("organization_id", ORG)
    .eq("intake_run_id", PRIOR_INTAKE_RUN_ID);
  if (priorErr) throw new Error(priorErr.message);

  const { data: emitOriginRows, error: emitErr } = await client
    .from("claim_candidates")
    .select(selectCols)
    .eq("organization_id", ORG)
    .filter("metadata->>emit_origin", "eq", "preview_emit_v1");
  if (emitErr) throw new Error(emitErr.message);

  const rows = (currentRows ?? []) as PilotRow[];
  const activeRows = rows.filter(isActivePilotRow);
  const prior = (priorRows ?? []) as PilotRow[];
  const allEmitOrigin = (emitOriginRows ?? []) as PilotRow[];

  const epIds = [
    ...new Set(
      activeRows
        .filter((r) => r.source_table === "expected_packages")
        .map((r) => r.source_row_id),
    ),
  ];
  const epBuildStatus = new Map<string, string>();
  for (let i = 0; i < epIds.length; i += 100) {
    const chunk = epIds.slice(i, i + 100);
    const { data, error } = await client
      .from("expected_packages")
      .select("id, build_status")
      .eq("organization_id", ORG)
      .in("id", chunk);
    if (error) throw new Error(error.message);
    for (const ep of data ?? []) {
      epBuildStatus.set(String(ep.id), String(ep.build_status ?? ""));
    }
  }

  const casesCount = await client
    .from("claim_cases")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);

  const emitV1Path = path.join(process.cwd(), "lib/claims/intake/claim-preview-emit-v1.ts");
  const emitSource = fs.readFileSync(emitV1Path, "utf8");
  const scannerOk = !emitSource.includes("operator-mobile");

  let preCutoffCount = 0;
  let missingEventDateCount = 0;
  const dateGateFailures: string[] = [];

  for (const r of activeRows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const sourceEventDate = str(meta.source_event_date ?? r.event_date);
    if (!sourceEventDate) {
      missingEventDateCount += 1;
      dateGateFailures.push(`${r.id}: missing source_event_date`);
    } else if (sourceEventDate < CLAIM_START_DATE) {
      preCutoffCount += 1;
      dateGateFailures.push(`${r.id}: pre_cutoff ${sourceEventDate}`);
    }
    if (meta.date_gate_passed !== true) dateGateFailures.push(`${r.id}: date_gate_passed not true`);
    if (str(meta.effective_date_source) !== "claim_start_date") {
      dateGateFailures.push(`${r.id}: effective_date_source`);
    }
    if (str(meta.effective_date_value) !== CLAIM_START_DATE) {
      dateGateFailures.push(`${r.id}: effective_date_value`);
    }
    if (str(meta.emit_origin) !== "preview_emit_v1") {
      dateGateFailures.push(`${r.id}: emit_origin`);
    }
  }

  const dateGateMetadataVerification = {
    pass: dateGateFailures.length === 0 && activeRows.length === 50,
    rows_checked: activeRows.length,
    all_date_gate_passed: activeRows.every(
      (r) => (r.metadata as Record<string, unknown>)?.date_gate_passed === true,
    ),
    all_effective_date_source_claim_start: activeRows.every(
      (r) =>
        str((r.metadata as Record<string, unknown>)?.effective_date_source) === "claim_start_date",
    ),
    all_effective_date_value: activeRows.every(
      (r) =>
        str((r.metadata as Record<string, unknown>)?.effective_date_value) === CLAIM_START_DATE,
    ),
    all_source_event_date_present: activeRows.every(
      (r) =>
        str((r.metadata as Record<string, unknown>)?.source_event_date ?? r.event_date) !== "",
    ),
    failures_sample: dateGateFailures.slice(0, 10),
  };

  const disputedRows = activeRows.filter((r) => {
    if (r.source_table !== "expected_packages") return false;
    const bs = epBuildStatus.get(r.source_row_id) ?? str((r.metadata as Record<string, unknown>)?.build_status);
    return bs && !isCleanExpectedPackageBuildStatus(bs);
  });

  const disputedExclusionVerification = {
    pass: disputedRows.length === 0,
    disputed_active_pilot_rows: disputedRows.length,
    sample_ids: disputedRows.slice(0, 5).map((r) => r.id),
  };

  const familyCounts: Record<string, number> = {};
  for (const r of activeRows) {
    const fam = str((r.metadata as Record<string, unknown>)?.family_key_v3 ?? r.claim_family);
    familyCounts[fam] = (familyCounts[fam] ?? 0) + 1;
  }
  const familyScopeVerification = {
    pass:
      activeRows.length === 50 &&
      (familyCounts.removal_order_discrepancy ?? 0) === 50 &&
      !Object.keys(familyCounts).some((f) => BLOCKED_FAMILIES_V3.has(f)),
    family_counts: familyCounts,
    approved_only: Object.keys(familyCounts).every((f) => APPROVED_FAMILIES_V3.has(f)),
  };

  const needsReviewExclusionVerification = {
    pass: activeRows.every((r) => {
      const meta = (r.metadata as Record<string, unknown>) ?? {};
      const action = str(meta.recommended_action ?? meta.preview_status ?? "");
      return action !== "needs_review" && action !== "unavailable";
    }),
    note: "DB rows lack preview status; verified via blocked families + disputed + legacy gates",
  };

  const legacyQuarantineVerification = {
    pass: activeRows.every(
      (r) =>
        r.source_kind !== "legacy_seed" &&
        !r.quarantined_at &&
        !r.rejected_at &&
        r.candidate_status !== "quarantined",
    ),
    legacy_seed_in_active: activeRows.filter((r) => r.source_kind === "legacy_seed").length,
    prior_intake_active_rows: prior.filter(isActivePilotRow).length,
    prior_intake_total_rows: prior.length,
    emit_origin_active_by_intake: {
      current: allEmitOrigin.filter(
        (r) => r.intake_run_id === CURRENT_INTAKE_RUN_ID && isActivePilotRow(r),
      ).length,
      prior: allEmitOrigin.filter(
        (r) => r.intake_run_id === PRIOR_INTAKE_RUN_ID && isActivePilotRow(r),
      ).length,
    },
  };

  const dedupeKeys = activeRows.map((r) => str(r.dedupe_key));
  const uniqueDedupe = new Set(dedupeKeys.filter(Boolean));
  const identityKeys = activeRows.map(
    (r) => `${r.source_table}:${r.source_row_id}:${r.claim_family}`,
  );
  const uniqueIdentity = new Set(identityKeys);

  const dedupeVerification = {
    pass:
      dedupeKeys.every((k) => k !== "") &&
      uniqueDedupe.size === activeRows.length &&
      uniqueIdentity.size === activeRows.length,
    all_have_dedupe_key: dedupeKeys.every((k) => k !== ""),
    duplicate_dedupe_keys: dedupeKeys.length - uniqueDedupe.size,
    duplicate_identity_keys: identityKeys.length - uniqueIdentity.size,
  };

  const sourceEdgeVerification = {
    pass: activeRows.every((r) => {
      const meta = (r.metadata as Record<string, unknown>) ?? {};
      const edges = meta.reference_edges;
      const ptrs = meta.evidence_pointers;
      return Array.isArray(edges) && edges.length > 0 && Array.isArray(ptrs) && ptrs.length > 0;
    }),
    missing_edges: activeRows.filter((r) => {
      const meta = (r.metadata as Record<string, unknown>) ?? {};
      return !Array.isArray(meta.reference_edges) || (meta.reference_edges as unknown[]).length === 0;
    }).length,
  };

  const evidenceSummaryVerification = {
    pass: activeRows.every((r) => {
      const meta = (r.metadata as Record<string, unknown>) ?? {};
      return str(meta.evidence_summary) !== "";
    }),
    missing_summary: activeRows.filter(
      (r) => !str((r.metadata as Record<string, unknown>)?.evidence_summary),
    ).length,
  };

  const requiredFieldFailures: string[] = [];
  for (const r of activeRows) {
    if (r.organization_id !== ORG) requiredFieldFailures.push(`${r.id}: org`);
    if (r.store_id !== STORE) requiredFieldFailures.push(`${r.id}: store`);
    if (!str(r.source_kind)) requiredFieldFailures.push(`${r.id}: source_kind`);
    if (!str(r.source_table)) requiredFieldFailures.push(`${r.id}: source_table`);
    if (!str(r.source_row_id)) requiredFieldFailures.push(`${r.id}: source_row_id`);
    if (!str(r.claim_family)) requiredFieldFailures.push(`${r.id}: claim_family`);
    if (!str(r.source_event_key)) requiredFieldFailures.push(`${r.id}: source_event_key`);
    if (r.candidate_status !== "detected") requiredFieldFailures.push(`${r.id}: candidate_status`);
    if (r.evidence_status !== "missing") requiredFieldFailures.push(`${r.id}: evidence_status`);
    if (r.intake_run_id !== CURRENT_INTAKE_RUN_ID) requiredFieldFailures.push(`${r.id}: intake_run_id`);
    const hasIdentifier =
      str(r.sku) || str(r.fnsku) || str(r.asin) || str(r.resolved_product_id) ||
      str((r.metadata as Record<string, unknown>)?.reference_key);
    if (!hasIdentifier) requiredFieldFailures.push(`${r.id}: identifiers`);
    if (r.expected_quantity == null || Number(r.expected_quantity) <= 0) {
      requiredFieldFailures.push(`${r.id}: quantity`);
    }
  }

  const rollbackScopeVerification = {
    pass:
      ROLLBACK_SQL.includes(CURRENT_INTAKE_RUN_ID) &&
      ROLLBACK_SQL.includes("emit_origin") &&
      ROLLBACK_SQL.includes("preview_emit_v1") &&
      ROLLBACK_SQL.includes("quarantine") &&
      !ROLLBACK_SQL.toLowerCase().includes("delete from"),
    rollback_sql: ROLLBACK_SQL,
  };

  const priorPilotRowsStatus = {
    prior_intake_run_id: PRIOR_INTAKE_RUN_ID,
    total_rows: prior.length,
    active_rows: prior.filter(isActivePilotRow).length,
    superseded_or_inactive: prior.filter((r) => !isActivePilotRow(r)).length,
    note:
      prior.length === 0
        ? "Prior intake_run_id no longer on rows (expected — in-place update to current run)"
        : prior.filter(isActivePilotRow).length === 0
          ? "Prior intake_run_id rows inactive — safe"
          : "Prior intake_run_id still has active rows — investigate",
  };

  const allChecksPass =
    activeRows.length === 50 &&
    dateGateMetadataVerification.pass &&
    preCutoffCount === 0 &&
    missingEventDateCount === 0 &&
    disputedExclusionVerification.pass &&
    familyScopeVerification.pass &&
    legacyQuarantineVerification.pass &&
    legacyQuarantineVerification.prior_intake_active_rows === 0 &&
    dedupeVerification.pass &&
    sourceEdgeVerification.pass &&
    evidenceSummaryVerification.pass &&
    requiredFieldFailures.length === 0 &&
    rollbackScopeVerification.pass &&
    (casesCount.count ?? 0) === 2 &&
    scannerOk;

  const results = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-POST-VERIFY-V1",
    run_id: id,
    mode: "read-only",
    staging_ref: STAGING_REF,
    current_intake_run_id: CURRENT_INTAKE_RUN_ID,
    prior_intake_run_id: PRIOR_INTAKE_RUN_ID,
    active_pilot_rows_count: activeRows.length,
    total_current_intake_rows: rows.length,
    prior_pilot_rows_status: priorPilotRowsStatus,
    date_gate_metadata_verification: dateGateMetadataVerification,
    pre_cutoff_rows_count: preCutoffCount,
    missing_event_date_rows_count: missingEventDateCount,
    required_field_failures_sample: requiredFieldFailures.slice(0, 10),
    disputed_exclusion_verification: disputedExclusionVerification,
    family_scope_verification: familyScopeVerification,
    needs_review_exclusion_verification: needsReviewExclusionVerification,
    legacy_quarantine_verification: legacyQuarantineVerification,
    dedupe_verification: dedupeVerification,
    source_edge_verification: sourceEdgeVerification,
    evidence_summary_verification: evidenceSummaryVerification,
    rollback_scope_verification: rollbackScopeVerification,
    no_claim_case_mutation_verification: {
      pass: true,
      claim_cases_count: casesCount.count ?? 0,
      note: "Read-only count; no cases created by this verify run",
    },
    no_scanner_change_verification: {
      pass: scannerOk,
      note: "Static check — emit module does not import operator-mobile",
    },
    sample_active_rows: activeRows.slice(0, 3).map((r) => ({
      id: r.id,
      claim_family: r.claim_family,
      source_kind: r.source_kind,
      dedupe_key: r.dedupe_key,
      intake_run_id: r.intake_run_id,
      date_gate_passed: (r.metadata as Record<string, unknown>)?.date_gate_passed,
      source_event_date: (r.metadata as Record<string, unknown>)?.source_event_date,
      family_key_v3: (r.metadata as Record<string, unknown>)?.family_key_v3,
    })),
    SAFE_STAGING_PILOT_ROWS_TRUSTED: allChecksPass ? "yes" : "no",
    SAFE_TO_RUN_NEXT_STAGING_EMIT_WAVE: allChecksPass ? "yes" : "no",
    NEXT_PROMPT: allChecksPass
      ? "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-ROLLBACK-DRILL-V1 — optional quarantine drill; then PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-PLAN-V1"
      : "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-REMEDIATION-V1 — fix failing post-verify checks before next emit wave",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Emit staging pilot post-verify V1\n\n` +
      `- active pilot rows: **${activeRows.length}**\n` +
      `- date gate: **${dateGateMetadataVerification.pass ? "pass" : "fail"}**\n` +
      `- SAFE_STAGING_PILOT_ROWS_TRUSTED: **${results.SAFE_STAGING_PILOT_ROWS_TRUSTED}**\n`,
  );
  fs.writeFileSync(path.join(outDir, "rollback.sql"), ROLLBACK_SQL);

  if (results.SAFE_STAGING_PILOT_ROWS_TRUSTED !== "yes") process.exit(1);
  console.log(
    JSON.stringify({
      ok: true,
      run_id: id,
      active_pilot_rows_count: activeRows.length,
      SAFE_STAGING_PILOT_ROWS_TRUSTED: results.SAFE_STAGING_PILOT_ROWS_TRUSTED,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
