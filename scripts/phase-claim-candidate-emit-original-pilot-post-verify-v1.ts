/**
 * PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-POST-VERIFY-V1 — original read-only row audit
 *   npx tsx scripts/phase-claim-candidate-emit-original-pilot-post-verify-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  APPROVED_EMIT_V3_FAMILIES,
  PREVIEW_ONLY_V3_FAMILIES,
} from "../lib/claims/contracts/claim-candidate-emit-approval-contract-v1";
import { isCleanExpectedPackageBuildStatus } from "../lib/expected-packages-conflict-status";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-post-verify-v1";
const PILOT_EVIDENCE_DIR =
  ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-v1/20260614T233000Z";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const CLAIM_START_DATE = "2026-01-15";
const APPROVED_FAMILIES_V3 = new Set(APPROVED_EMIT_V3_FAMILIES);
const PREVIEW_ONLY_FAMILIES_V3 = new Set([
  ...PREVIEW_ONLY_V3_FAMILIES,
  "needs_review",
  "unavailable",
]);

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

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function loadPilotEvidence(): {
  intake_run_id: string;
  inserted_count: number;
  updated_count: number;
  safe_original_emit_pilot: string;
  claim_cases_before: number;
} {
  const resultsPath = path.join(process.cwd(), PILOT_EVIDENCE_DIR, "results.json");
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`BLOCKED: pilot evidence missing at ${resultsPath}`);
  }
  const pilot = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as Record<string, unknown>;
  const safe = str(pilot.SAFE_ORIGINAL_EMIT_PILOT);
  if (safe !== "yes") {
    throw new Error(`BLOCKED: SAFE_ORIGINAL_EMIT_PILOT must be yes (got ${safe || "missing"})`);
  }
  const casesBefore = (
    pilot.claim_cases_count_before_after as { before?: number } | undefined
  )?.before;
  return {
    intake_run_id: str(pilot.intake_run_id),
    inserted_count: Number(pilot.inserted_count ?? 0),
    updated_count: Number(pilot.updated_count ?? 0),
    safe_original_emit_pilot: safe,
    claim_cases_before: Number.isFinite(casesBefore) ? Number(casesBefore) : 2,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const pilot = loadPilotEvidence();
  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });

  const rollbackPath = path.join(process.cwd(), PILOT_EVIDENCE_DIR, "rollback.sql");
  const rollbackSql = fs.existsSync(rollbackPath)
    ? fs.readFileSync(rollbackPath, "utf8")
    : "";

  const selectCols =
    "id, organization_id, store_id, source_kind, source_table, source_row_id, claim_family, dedupe_key, source_event_key, sku, fnsku, asin, resolved_product_id, expected_quantity, candidate_status, evidence_status, intake_run_id, quarantined_at, rejected_at, metadata, event_date";

  const { data: intakeRows, error: intakeErr } = await client
    .from("claim_candidates")
    .select(selectCols)
    .eq("organization_id", ORG)
    .eq("intake_run_id", pilot.intake_run_id);
  if (intakeErr) throw new Error(intakeErr.message);

  const rows = (intakeRows ?? []) as PilotRow[];
  const activeRows = rows.filter(isActivePilotRow);
  const expectedActive = pilot.inserted_count + pilot.updated_count;

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

  const casesCount = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count;

  const emitV1Path = path.join(process.cwd(), "lib/claims/intake/claim-preview-emit-v1.ts");
  const emitSource = fs.readFileSync(emitV1Path, "utf8");
  const scannerStaticOk = !emitSource.includes("operator-mobile");
  const scannerGit = scannerGitStatus();

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
    if (!str(meta.effective_date_source)) dateGateFailures.push(`${r.id}: effective_date_source`);
    if (!str(meta.effective_date_value)) dateGateFailures.push(`${r.id}: effective_date_value`);
    if (str(meta.emit_origin) !== "preview_emit_v1") dateGateFailures.push(`${r.id}: emit_origin`);
  }

  const dateGateMetadataVerification = {
    pass:
      dateGateFailures.length === 0 &&
      activeRows.length === expectedActive &&
      preCutoffCount === 0 &&
      missingEventDateCount === 0,
    rows_checked: activeRows.length,
    expected_active_rows: expectedActive,
    all_date_gate_passed: activeRows.every(
      (r) => (r.metadata as Record<string, unknown>)?.date_gate_passed === true,
    ),
    all_effective_date_source_present: activeRows.every(
      (r) => str((r.metadata as Record<string, unknown>)?.effective_date_source) !== "",
    ),
    all_effective_date_value_present: activeRows.every(
      (r) => str((r.metadata as Record<string, unknown>)?.effective_date_value) !== "",
    ),
    all_source_event_date_present: activeRows.every(
      (r) =>
        str((r.metadata as Record<string, unknown>)?.source_event_date ?? r.event_date) !== "",
    ),
    failures_sample: dateGateFailures.slice(0, 10),
  };

  const disputedRows = activeRows.filter((r) => {
    if (r.source_table !== "expected_packages") return false;
    const bs =
      epBuildStatus.get(r.source_row_id) ?? str((r.metadata as Record<string, unknown>)?.build_status);
    return bs && !isCleanExpectedPackageBuildStatus(bs);
  });

  const disputedExclusionVerification = {
    pass: disputedRows.length === 0,
    disputed_active_pilot_rows: disputedRows.length,
    sample_ids: disputedRows.slice(0, 5).map((r) => r.id),
  };

  const familyDistribution: Record<string, number> = {};
  const claimFamilyDistribution: Record<string, number> = {};
  for (const r of activeRows) {
    const fam = str((r.metadata as Record<string, unknown>)?.family_key_v3 ?? r.claim_family);
    familyDistribution[fam] = (familyDistribution[fam] ?? 0) + 1;
    claimFamilyDistribution[r.claim_family] = (claimFamilyDistribution[r.claim_family] ?? 0) + 1;
  }

  const previewOnlyEmitted = activeRows.filter((r) => {
    const fam = str((r.metadata as Record<string, unknown>)?.family_key_v3);
    return PREVIEW_ONLY_FAMILIES_V3.has(fam);
  });

  const previewOnlyFamilyExclusionVerification = {
    pass: previewOnlyEmitted.length === 0,
    preview_only_emitted: previewOnlyEmitted.length,
    approved_only: Object.keys(familyDistribution).every((f) => APPROVED_FAMILIES_V3.has(f)),
    family_distribution: familyDistribution,
    claim_family_distribution: claimFamilyDistribution,
  };

  const needsReviewExclusionVerification = {
    pass: activeRows.every((r) => {
      const meta = (r.metadata as Record<string, unknown>) ?? {};
      const action = str(meta.recommended_action ?? meta.preview_status ?? "");
      return action !== "needs_review" && action !== "unavailable";
    }),
    needs_review_or_unavailable: activeRows.filter((r) => {
      const meta = (r.metadata as Record<string, unknown>) ?? {};
      const action = str(meta.recommended_action ?? meta.preview_status ?? "");
      return action === "needs_review" || action === "unavailable";
    }).length,
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
    quarantined_same_intake: rows.filter((r) => r.quarantined_at).length,
    superseded_same_intake: rows.filter((r) => r.candidate_status === "superseded").length,
  };

  const dedupeKeys = activeRows.map((r) => str(r.dedupe_key));
  const uniqueDedupe = new Set(dedupeKeys.filter(Boolean));
  const identityKeys = activeRows.map(
    (r) => `${r.source_table}:${r.source_row_id}:${r.claim_family}`,
  );
  const uniqueIdentity = new Set(identityKeys);

  const { data: globalActive } = await client
    .from("claim_candidates")
    .select("id, source_table, source_row_id, claim_family, dedupe_key, intake_run_id")
    .eq("organization_id", ORG)
    .is("quarantined_at", null)
    .is("rejected_at", null)
    .neq("source_kind", "legacy_seed");

  const globalIdentityMap = new Map<string, string[]>();
  const globalDedupeMap = new Map<string, string[]>();
  for (const row of (globalActive ?? []) as Array<{
    id: string;
    source_table: string;
    source_row_id: string;
    claim_family: string;
    dedupe_key: string | null;
    intake_run_id: string | null;
  }>) {
    const ik = `${row.source_table}:${row.source_row_id}:${row.claim_family}`;
    const ids = globalIdentityMap.get(ik) ?? [];
    ids.push(row.id);
    globalIdentityMap.set(ik, ids);
    if (row.dedupe_key) {
      const dIds = globalDedupeMap.get(row.dedupe_key) ?? [];
      dIds.push(row.id);
      globalDedupeMap.set(row.dedupe_key, dIds);
    }
  }

  const identityCollisions = [...globalIdentityMap.entries()].filter(([, ids]) => ids.length > 1);
  const dedupeCollisions = [...globalDedupeMap.entries()].filter(([, ids]) => ids.length > 1);

  const identityCollisionCheck = {
    pass: identityCollisions.length === 0 && uniqueIdentity.size === activeRows.length,
    pilot_duplicate_identity_keys: identityKeys.length - uniqueIdentity.size,
    global_identity_collision_groups: identityCollisions.length,
    global_collision_sample: identityCollisions.slice(0, 3).map(([k, ids]) => ({ key: k, ids })),
  };

  const dedupeVerification = {
    pass:
      dedupeKeys.every((k) => k !== "") &&
      uniqueDedupe.size === activeRows.length &&
      dedupeCollisions.length === 0,
    all_have_dedupe_key: dedupeKeys.every((k) => k !== ""),
    duplicate_dedupe_keys_in_pilot: dedupeKeys.length - uniqueDedupe.size,
    global_dedupe_collision_groups: dedupeCollisions.length,
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
    if (!str(r.dedupe_key)) requiredFieldFailures.push(`${r.id}: dedupe_key`);
    if (!str(r.source_event_key)) requiredFieldFailures.push(`${r.id}: source_event_key`);
    if (r.candidate_status !== "detected") requiredFieldFailures.push(`${r.id}: candidate_status`);
    if (r.evidence_status !== "missing") requiredFieldFailures.push(`${r.id}: evidence_status`);
    if (r.intake_run_id !== pilot.intake_run_id) requiredFieldFailures.push(`${r.id}: intake_run_id`);
    const hasIdentifier =
      str(r.sku) ||
      str(r.fnsku) ||
      str(r.asin) ||
      str(r.resolved_product_id) ||
      str((r.metadata as Record<string, unknown>)?.reference_key);
    if (!hasIdentifier) requiredFieldFailures.push(`${r.id}: identifiers`);
    if (r.expected_quantity == null || Number(r.expected_quantity) <= 0) {
      requiredFieldFailures.push(`${r.id}: quantity`);
    }
  }

  const rollbackScopeVerification = {
    pass:
      rollbackSql.includes(pilot.intake_run_id) &&
      rollbackSql.includes("emit_origin") &&
      rollbackSql.includes("preview_emit_v1") &&
      rollbackSql.includes("quarantine") &&
      !rollbackSql.toLowerCase().includes("delete from"),
    rollback_sql_path: PILOT_EVIDENCE_DIR + "/rollback.sql",
    rollback_exists: rollbackSql.length > 0,
  };

  const pilotIdSet = new Set(activeRows.map((r) => r.id));
  const pilotIds = [...pilotIdSet];

  const { data: visibleRows, error: visErr } = await client
    .from("claim_candidates")
    .select("id, candidate_status, evidence_status, source_kind, quarantined_at")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .is("quarantined_at", null)
    .neq("source_kind", "legacy_seed")
    .in("id", pilotIds);
  if (visErr) throw new Error(visErr.message);

  const visible = (visibleRows ?? []) as Array<{
    id: string;
    candidate_status: string | null;
    evidence_status: string | null;
  }>;

  const { count: activeDbTotal } = await client
    .from("claim_candidates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .is("quarantined_at", null)
    .neq("source_kind", "legacy_seed");

  const proofEligible = visible.filter((r) => r.evidence_status === "missing").length;
  const detectedEligible = visible.filter((r) => r.candidate_status === "detected").length;

  const candidateQueueVisibility = {
    pass: visible.length === activeRows.length,
    pilot_rows_expected: activeRows.length,
    pilot_rows_in_active_pool: visible.length,
    active_db_total_non_legacy: activeDbTotal ?? 0,
    detected_status_visible: detectedEligible,
    proof_queue_eligible_missing_evidence: proofEligible,
    sample_visible_ids: visible.slice(0, 5).map((r) => r.id),
    note:
      "Pilot rows match Claim Center active candidate pool filters (non-legacy, non-quarantined); no approve/reject performed",
  };

  const rowCountVerification = {
    pass: activeRows.length === expectedActive,
    active_pilot_rows: activeRows.length,
    expected_from_pilot: expectedActive,
    total_intake_rows_including_quarantined: rows.length,
  };

  const allChecksPass =
    rowCountVerification.pass &&
    dateGateMetadataVerification.pass &&
    disputedExclusionVerification.pass &&
    previewOnlyFamilyExclusionVerification.pass &&
    needsReviewExclusionVerification.pass &&
    legacyQuarantineVerification.pass &&
    identityCollisionCheck.pass &&
    dedupeVerification.pass &&
    sourceEdgeVerification.pass &&
    evidenceSummaryVerification.pass &&
    requiredFieldFailures.length === 0 &&
    rollbackScopeVerification.pass &&
    (casesCount ?? 0) === pilot.claim_cases_before &&
    scannerStaticOk &&
    candidateQueueVisibility.pass;

  const results = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-POST-VERIFY-V1",
    run_id: id,
    mode: "read-only",
    original_ref: PRODUCTION_REF,
    prerequisite: {
      pilot_run_id: "20260614T233000Z",
      SAFE_ORIGINAL_EMIT_PILOT: pilot.safe_original_emit_pilot,
    },
    intake_run_id: pilot.intake_run_id,
    active_pilot_rows_count: activeRows.length,
    row_count_verification: rowCountVerification,
    family_distribution: familyDistribution,
    claim_family_distribution: claimFamilyDistribution,
    date_gate_metadata_verification: dateGateMetadataVerification,
    pre_cutoff_rows_count: preCutoffCount,
    missing_event_date_rows_count: missingEventDateCount,
    required_field_failures_sample: requiredFieldFailures.slice(0, 10),
    disputed_exclusion_verification: disputedExclusionVerification,
    needs_review_exclusion_verification: needsReviewExclusionVerification,
    preview_only_family_exclusion_verification: previewOnlyFamilyExclusionVerification,
    legacy_quarantine_verification: legacyQuarantineVerification,
    identity_collision_check: identityCollisionCheck,
    dedupe_verification: dedupeVerification,
    source_edge_verification: sourceEdgeVerification,
    evidence_summary_verification: evidenceSummaryVerification,
    claim_cases_count_before_after: {
      pass: (casesCount ?? 0) === pilot.claim_cases_before,
      before: pilot.claim_cases_before,
      after: casesCount ?? 0,
    },
    no_scanner_change_verification: {
      pass: scannerStaticOk,
      git_porcelain_app_scanner: scannerGit,
      static_emit_module_no_scanner_import: scannerStaticOk,
    },
    rollback_scope_verification: rollbackScopeVerification,
    candidate_queue_visibility: candidateQueueVisibility,
    sample_active_rows: activeRows.slice(0, 3).map((r) => ({
      id: r.id,
      claim_family: r.claim_family,
      source_kind: r.source_kind,
      dedupe_key: r.dedupe_key,
      family_key_v3: (r.metadata as Record<string, unknown>)?.family_key_v3,
      date_gate_passed: (r.metadata as Record<string, unknown>)?.date_gate_passed,
      source_event_date: (r.metadata as Record<string, unknown>)?.source_event_date,
    })),
    SAFE_ORIGINAL_PILOT_ROWS_TRUSTED: allChecksPass ? "yes" : "no",
    SAFE_TO_BUILD_REVIEW_UI_FOR_ORIGINAL_CANDIDATES: allChecksPass ? "yes" : "no",
    SAFE_TO_PLAN_ORIGINAL_EMIT_EXPANSION: allChecksPass ? "yes" : "no",
    NEXT_PROMPT: allChecksPass
      ? "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-ROLLBACK-DRILL-V1 — quarantine drill on original; then operator UI review of trusted pilot rows"
      : "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-REMEDIATION-V1 — fix failing post-verify checks before UI review or expansion",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Original emit pilot post-verify V1

**Run:** ${id} · **Ref:** ${PRODUCTION_REF} · **Mode:** read-only

- intake_run_id: \`${pilot.intake_run_id}\`
- active pilot rows: **${activeRows.length}** (expected ${expectedActive})
- family: shipment=${familyDistribution.removal_shipment_missing ?? 0} · order=${familyDistribution.removal_order_discrepancy ?? 0}
- Claim Center visibility: **${visible.length}/${activeRows.length}**
- SAFE_ORIGINAL_PILOT_ROWS_TRUSTED: **${results.SAFE_ORIGINAL_PILOT_ROWS_TRUSTED}**
`,
  );

  console.log(
    JSON.stringify({
      ok: allChecksPass,
      run_id: id,
      intake_run_id: pilot.intake_run_id,
      active_pilot_rows_count: activeRows.length,
      SAFE_ORIGINAL_PILOT_ROWS_TRUSTED: results.SAFE_ORIGINAL_PILOT_ROWS_TRUSTED,
      outDir,
    }),
  );
  if (!allChecksPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
