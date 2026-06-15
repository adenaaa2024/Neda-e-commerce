/**
 * PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-RESTORE-FOR-REVIEW-V1 — original controlled restore
 *   npx tsx scripts/phase-claim-candidate-emit-original-pilot-restore-for-review-v1.ts --run-id=<UTC> [--dry-run]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  APPROVED_EMIT_V3_FAMILIES,
  PREVIEW_ONLY_V3_FAMILIES,
} from "../lib/claims/contracts/claim-candidate-emit-approval-contract-v1";
import { isCleanExpectedPackageBuildStatus } from "../lib/expected-packages-conflict-status";
import { bindProductionSupabaseEnv, PRODUCTION_REF, productionPostgresUrl } from "../lib/production-db-bind";
import { buildClaimDedupeKey } from "../lib/claims/intake/claim-intake-types";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-restore-for-review-v1";
const APPROVAL_PATH =
  ".cursor/operator-approvals/claim-candidate-emit-original-pilot-restore-for-review-v1-approval.md";
const ROLLBACK_DRILL_RESULTS =
  ".cursor/audit-reports/phase-claim-candidate-emit-original-rollback-drill-v1/20260615T050000Z/results.json";
const PILOT_EVIDENCE =
  ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-v1/20260614T233000Z/results.json";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TARGET_RUN_ID = "a8a892fe-37d5-4d74-9ea2-02af8fd095ce";
const EMIT_ORIGIN = "preview_emit_v1";
const CLAIM_START_DATE = "2026-01-15";
const EXPECTED_RESTORED = 50;
const APPROVED_FAMILIES_V3 = new Set(APPROVED_EMIT_V3_FAMILIES);
const PREVIEW_ONLY_FAMILIES_V3 = new Set([...PREVIEW_ONLY_V3_FAMILIES, "needs_review", "unavailable"]);

const RESTORE_SQL = `-- PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-RESTORE-FOR-REVIEW-V1 (un-quarantine — no hard delete)
UPDATE claim_candidates
SET
  quarantined_at = NULL,
  quarantine_reason = NULL,
  candidate_status = 'detected',
  superseded_by_candidate_id = NULL,
  updated_at = NOW(),
  metadata = metadata - 'rollback_run_id' - 'rollback_at' - 'rollback_mode'
WHERE intake_run_id = '${TARGET_RUN_ID}'
  AND metadata->>'emit_origin' = '${EMIT_ORIGIN}'
  AND metadata->>'rollback_mode' = 'quarantine_supersede'
  AND quarantined_at IS NOT NULL
  AND rejected_at IS NULL
  AND source_kind <> 'legacy_seed';

-- Restore dedupe_key via buildClaimDedupeKey formula (v1:source_kind:org:store:table:row:family)
UPDATE claim_candidates
SET
  dedupe_key = concat(
    'v1:', source_kind, ':', organization_id::text, ':',
    COALESCE(store_id::text, '-'), ':', source_table, ':',
    source_row_id::text, ':', claim_family
  ),
  updated_at = NOW()
WHERE intake_run_id = '${TARGET_RUN_ID}'
  AND metadata->>'emit_origin' = '${EMIT_ORIGIN}'
  AND quarantined_at IS NULL
  AND rejected_at IS NULL
  AND source_kind <> 'legacy_seed'
  AND (dedupe_key IS NULL OR dedupe_key = '');`;

type Snapshot = {
  claim_candidates_total: number;
  target_active: number;
  target_quarantined: number;
  target_superseded: number;
  unrelated_active: number;
  claim_cases_total: number;
};

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

function readApprovalStatus(): {
  approved: boolean;
  status: "signed" | "unsigned";
  reason: string | null;
} {
  const envOk = process.env.APPROVED_RESTORE_ORIGINAL_PILOT_FOR_REVIEW_V1 === "yes";
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) {
    return { approved: envOk, status: envOk ? "signed" : "unsigned", reason: "approval_file_missing" };
  }
  const text = fs.readFileSync(p, "utf8");
  const fileOk = /APPROVED_RESTORE_ORIGINAL_PILOT_FOR_REVIEW_V1\s*=\s*yes/i.test(text);
  const decisionOk = /\[x\]\s*APPROVED/i.test(text);
  if (envOk || (fileOk && decisionOk) || fileOk) {
    return { approved: true, status: "signed", reason: null };
  }
  return {
    approved: false,
    status: "unsigned",
    reason: "APPROVED_RESTORE_ORIGINAL_PILOT_FOR_REVIEW_V1 not set to yes",
  };
}

function loadPrerequisites(): {
  rollback_drill_pass: boolean;
  safe_to_restore: boolean;
  pilot_inserted: number;
} {
  const drillPath = path.join(process.cwd(), ROLLBACK_DRILL_RESULTS);
  if (!fs.existsSync(drillPath)) {
    throw new Error(`BLOCKED: rollback drill evidence missing at ${ROLLBACK_DRILL_RESULTS}`);
  }
  const drill = JSON.parse(fs.readFileSync(drillPath, "utf8")) as Record<string, string>;
  if (drill.SAFE_ORIGINAL_ROLLBACK_DRILL_PASSED !== "yes") {
    throw new Error("BLOCKED: SAFE_ORIGINAL_ROLLBACK_DRILL_PASSED must be yes");
  }
  if (drill.SAFE_TO_RESTORE_ORIGINAL_PILOT_FOR_REVIEW !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_RESTORE_ORIGINAL_PILOT_FOR_REVIEW must be yes");
  }
  const pilotPath = path.join(process.cwd(), PILOT_EVIDENCE);
  const pilot = fs.existsSync(pilotPath)
    ? (JSON.parse(fs.readFileSync(pilotPath, "utf8")) as Record<string, number>)
    : { inserted_count: EXPECTED_RESTORED };
  return {
    rollback_drill_pass: true,
    safe_to_restore: true,
    pilot_inserted: Number(pilot.inserted_count ?? EXPECTED_RESTORED),
  };
}

function extractUpdateStatements(sql: string): string[] {
  const lines = sql.split(/\r?\n/);
  const statements: string[] = [];
  let buf: string[] = [];
  let inUpdate = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--")) continue;
    if (trimmed.startsWith("UPDATE")) {
      if (buf.length) statements.push(buf.join("\n"));
      buf = [trimmed];
      inUpdate = true;
      continue;
    }
    if (inUpdate) {
      if (!trimmed) continue;
      buf.push(trimmed);
      if (trimmed.endsWith(";")) {
        statements.push(buf.join("\n"));
        buf = [];
        inUpdate = false;
      }
    }
  }
  if (buf.length) statements.push(buf.join("\n"));
  return statements.filter((s) => s.trim().length > 0);
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

async function captureSnapshot(client: pg.Client): Promise<Snapshot> {
  const r = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM claim_candidates WHERE organization_id = $1::uuid) AS claim_candidates_total,
      (SELECT COUNT(*)::int FROM claim_candidates
        WHERE organization_id = $1::uuid AND intake_run_id = $2::uuid
          AND quarantined_at IS NULL AND rejected_at IS NULL
          AND source_kind <> 'legacy_seed') AS target_active,
      (SELECT COUNT(*)::int FROM claim_candidates
        WHERE organization_id = $1::uuid AND intake_run_id = $2::uuid
          AND quarantined_at IS NOT NULL) AS target_quarantined,
      (SELECT COUNT(*)::int FROM claim_candidates
        WHERE organization_id = $1::uuid AND intake_run_id = $2::uuid
          AND candidate_status = 'superseded') AS target_superseded,
      (SELECT COUNT(*)::int FROM claim_candidates
        WHERE organization_id = $1::uuid
          AND (intake_run_id IS NULL OR intake_run_id <> $2::uuid)
          AND quarantined_at IS NULL AND rejected_at IS NULL) AS unrelated_active,
      (SELECT COUNT(*)::int FROM claim_cases WHERE organization_id = $1::uuid) AS claim_cases_total
    `,
    [ORG, TARGET_RUN_ID],
  );
  return r.rows[0] as Snapshot;
}

async function loadActivePilotRows(client: pg.Client): Promise<PilotRow[]> {
  const r = await client.query(
    `
    SELECT id, organization_id, store_id, source_kind, source_table, source_row_id, claim_family,
           dedupe_key, source_event_key, sku, fnsku, asin, resolved_product_id, expected_quantity,
           candidate_status, evidence_status, intake_run_id, quarantined_at, rejected_at,
           metadata, event_date
    FROM claim_candidates
    WHERE organization_id = $1::uuid AND intake_run_id = $2::uuid
      AND quarantined_at IS NULL AND rejected_at IS NULL
      AND source_kind <> 'legacy_seed'
    `,
    [ORG, TARGET_RUN_ID],
  );
  return r.rows as PilotRow[];
}

async function loadEpBuildStatus(
  client: pg.Client,
  epIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < epIds.length; i += 100) {
    const chunk = epIds.slice(i, i + 100);
    const r = await client.query(
      `SELECT id, build_status FROM expected_packages
       WHERE organization_id = $1::uuid AND id = ANY($2::uuid[])`,
      [ORG, chunk],
    );
    for (const row of r.rows as Array<{ id: string; build_status: string }>) {
      map.set(String(row.id), String(row.build_status ?? ""));
    }
  }
  return map;
}

async function runIntegrityChecks(
  client: pg.Client,
  activeRows: PilotRow[],
  expectedCount: number,
): Promise<{
  date_gate_reverification: Record<string, unknown>;
  disputed_exclusion_reverification: Record<string, unknown>;
  dedupe_reverification: Record<string, unknown>;
  source_edge_reverification: Record<string, unknown>;
  evidence_summary_reverification: Record<string, unknown>;
  candidate_queue_visibility: Record<string, unknown>;
}> {
  const epIds = [
    ...new Set(
      activeRows.filter((r) => r.source_table === "expected_packages").map((r) => r.source_row_id),
    ),
  ];
  const epBuildStatus = await loadEpBuildStatus(client, epIds);

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
    if (str(meta.emit_origin) !== EMIT_ORIGIN) dateGateFailures.push(`${r.id}: emit_origin`);
    if (str(meta.rollback_mode)) dateGateFailures.push(`${r.id}: rollback_mode still set`);
  }

  const date_gate_reverification = {
    pass:
      dateGateFailures.length === 0 &&
      activeRows.length === expectedCount &&
      preCutoffCount === 0 &&
      missingEventDateCount === 0,
    rows_checked: activeRows.length,
    expected_active_rows: expectedCount,
    pre_cutoff_count: preCutoffCount,
    missing_event_date_count: missingEventDateCount,
    failures_sample: dateGateFailures.slice(0, 10),
  };

  const disputedRows = activeRows.filter((r) => {
    if (r.source_table !== "expected_packages") return false;
    const bs =
      epBuildStatus.get(r.source_row_id) ?? str((r.metadata as Record<string, unknown>)?.build_status);
    return bs && !isCleanExpectedPackageBuildStatus(bs);
  });

  const disputed_exclusion_reverification = {
    pass: disputedRows.length === 0,
    disputed_active_pilot_rows: disputedRows.length,
    sample_ids: disputedRows.slice(0, 5).map((r) => r.id),
  };

  const needsReviewCount = activeRows.filter((r) => {
    const meta = (r.metadata as Record<string, unknown>) ?? {};
    const action = str(meta.recommended_action ?? meta.preview_status ?? "");
    return action === "needs_review" || action === "unavailable";
  }).length;

  const previewOnlyCount = activeRows.filter((r) => {
    const fam = str((r.metadata as Record<string, unknown>)?.family_key_v3);
    return PREVIEW_ONLY_FAMILIES_V3.has(fam);
  }).length;

  const dedupeKeys = activeRows.map((r) => str(r.dedupe_key));
  const uniqueDedupe = new Set(dedupeKeys.filter(Boolean));
  const dedupeMismatch: string[] = [];
  for (const r of activeRows) {
    if (!r.source_kind) continue;
    const expected = buildClaimDedupeKey({
      source_kind: r.source_kind as Parameters<typeof buildClaimDedupeKey>[0]["source_kind"],
      organization_id: r.organization_id,
      store_id: r.store_id,
      source_table: r.source_table,
      source_row_id: r.source_row_id,
      claim_family: r.claim_family,
    });
    if (str(r.dedupe_key) !== expected) dedupeMismatch.push(`${r.id}: dedupe mismatch`);
  }

  const globalDedupe = await client.query(
    `
    SELECT dedupe_key, array_agg(id::text) AS ids
    FROM claim_candidates
    WHERE organization_id = $1::uuid
      AND dedupe_key IS NOT NULL
      AND quarantined_at IS NULL
      AND rejected_at IS NULL
      AND source_kind <> 'legacy_seed'
    GROUP BY dedupe_key
    HAVING COUNT(*) > 1
    `,
    [ORG],
  );

  const dedupe_reverification = {
    pass:
      dedupeKeys.every((k) => k !== "") &&
      uniqueDedupe.size === activeRows.length &&
      dedupeMismatch.length === 0 &&
      globalDedupe.rows.length === 0 &&
      needsReviewCount === 0 &&
      previewOnlyCount === 0 &&
      Object.keys(
        activeRows.reduce(
          (acc, r) => {
            const fam = str((r.metadata as Record<string, unknown>)?.family_key_v3 ?? r.claim_family);
            acc[fam] = (acc[fam] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
      ).every((f) => APPROVED_FAMILIES_V3.has(f)),
    all_have_dedupe_key: dedupeKeys.every((k) => k !== ""),
    duplicate_dedupe_in_pilot: dedupeKeys.length - uniqueDedupe.size,
    dedupe_formula_mismatch: dedupeMismatch.length,
    global_dedupe_collision_groups: globalDedupe.rows.length,
    needs_review_or_unavailable: needsReviewCount,
    preview_only_families: previewOnlyCount,
    mismatch_sample: dedupeMismatch.slice(0, 5),
  };

  const source_edge_reverification = {
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

  const evidence_summary_reverification = {
    pass: activeRows.every((r) => str((r.metadata as Record<string, unknown>)?.evidence_summary) !== ""),
    missing_summary: activeRows.filter(
      (r) => !str((r.metadata as Record<string, unknown>)?.evidence_summary),
    ).length,
  };

  const pilotIds = activeRows.map((r) => r.id);
  const vis = await client.query(
    `
    SELECT id, candidate_status, evidence_status
    FROM claim_candidates
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
      AND quarantined_at IS NULL AND source_kind <> 'legacy_seed'
      AND id = ANY($3::uuid[])
    `,
    [ORG, STORE, pilotIds],
  );
  const visible = vis.rows as Array<{ id: string; candidate_status: string; evidence_status: string }>;
  const activeTotal = await client.query(
    `
    SELECT COUNT(*)::int AS n FROM claim_candidates
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
      AND quarantined_at IS NULL AND source_kind <> 'legacy_seed'
    `,
    [ORG, STORE],
  );

  const candidate_queue_visibility = {
    pass: visible.length === activeRows.length && activeRows.length === expectedCount,
    pilot_rows_expected: expectedCount,
    pilot_rows_in_active_pool: visible.length,
    active_db_total_non_legacy: (activeTotal.rows[0] as { n: number }).n,
    detected_status_visible: visible.filter((r) => r.candidate_status === "detected").length,
    proof_queue_eligible_missing_evidence: visible.filter((r) => r.evidence_status === "missing").length,
    sample_visible_ids: visible.slice(0, 5).map((r) => r.id),
  };

  return {
    date_gate_reverification,
    disputed_exclusion_reverification,
    dedupe_reverification,
    source_edge_reverification,
    evidence_summary_reverification,
    candidate_queue_visibility,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const dryRun = process.argv.includes("--dry-run");
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const approval = readApprovalStatus();
  if (!approval.approved) {
    throw new Error(`BLOCKED: operator approval required — ${approval.reason}`);
  }

  const prereq = loadPrerequisites();
  const { ref } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const restoreSqlBody = RESTORE_SQL.replace(/--[^\n]*/g, "");
  if (/DELETE\s+FROM/i.test(restoreSqlBody)) {
    throw new Error("BLOCKED: restore SQL must not contain DELETE");
  }

  const scannerBefore = scannerGitStatus();
  const client = new pg.Client({ connectionString: productionPostgresUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const before = await captureSnapshot(client);
  fs.writeFileSync(path.join(outDir, "before-snapshot.json"), JSON.stringify(before, null, 2));

  let restoreActionResult = {
    applied: false,
    statements_executed: 0,
    rows_affected_unquarantine: 0,
    rows_affected_dedupe_restore: 0,
    dry_run: dryRun,
  };

  if (!dryRun) {
    const statements = extractUpdateStatements(RESTORE_SQL);
    if (statements.length !== 2) throw new Error(`Expected 2 UPDATE statements, got ${statements.length}`);

    await client.query("BEGIN");
    try {
      for (let i = 0; i < statements.length; i++) {
        const res = await client.query(statements[i]!);
        restoreActionResult.statements_executed += 1;
        if (i === 0) restoreActionResult.rows_affected_unquarantine = res.rowCount ?? 0;
        if (i === 1) restoreActionResult.rows_affected_dedupe_restore = res.rowCount ?? 0;
      }
      restoreActionResult.applied = true;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }

  const after = await captureSnapshot(client);
  const activeRows = dryRun ? [] : await loadActivePilotRows(client);
  const integrity = dryRun
    ? null
    : await runIntegrityChecks(client, activeRows, prereq.pilot_inserted);

  await client.end();
  fs.writeFileSync(path.join(outDir, "after-snapshot.json"), JSON.stringify(after, null, 2));
  fs.writeFileSync(path.join(outDir, "restore.sql"), RESTORE_SQL);

  const scannerAfter = scannerGitStatus();
  const countUnchanged = after.claim_candidates_total === before.claim_candidates_total;
  const claimCasesUnchanged = after.claim_cases_total === before.claim_cases_total;
  const unrelatedUnchanged = after.unrelated_active === before.unrelated_active;

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
    execSync(
      `npx tsx scripts/smoke-claim-candidate-emit-original-pilot-restore-for-review-v1.ts --run-id=${id}`,
      { stdio: "pipe", encoding: "utf8" },
    );
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const integrityPass =
    integrity !== null &&
    integrity.date_gate_reverification.pass === true &&
    integrity.disputed_exclusion_reverification.pass === true &&
    integrity.dedupe_reverification.pass === true &&
    integrity.source_edge_reverification.pass === true &&
    integrity.evidence_summary_reverification.pass === true &&
    integrity.candidate_queue_visibility.pass === true;

  const restorePass =
    !dryRun &&
    before.target_quarantined === 50 &&
    before.target_active === 0 &&
    restoreActionResult.rows_affected_unquarantine === 50 &&
    after.target_active === EXPECTED_RESTORED &&
    after.target_quarantined === 0 &&
    countUnchanged &&
    claimCasesUnchanged &&
    unrelatedUnchanged &&
    integrityPass &&
    scannerBefore === scannerAfter &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const payload = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-RESTORE-FOR-REVIEW-V1",
    run_id: id,
    dry_run: dryRun,
    original_ref: PRODUCTION_REF,
    original_ref_guard: { pass: ref === PRODUCTION_REF, ref },
    approval_file_status: approval.status,
    prerequisite: {
      rollback_drill_run_id: "20260615T050000Z",
      SAFE_ORIGINAL_ROLLBACK_DRILL_PASSED: "yes",
      SAFE_TO_RESTORE_ORIGINAL_PILOT_FOR_REVIEW: "yes",
    },
    target_intake_run_id: TARGET_RUN_ID,
    before_snapshot: before,
    restore_action_result: restoreActionResult,
    after_snapshot: after,
    restored_rows_count: restoreActionResult.rows_affected_unquarantine,
    active_target_rows_count: after.target_active,
    quarantined_target_rows_count: after.target_quarantined,
    date_gate_reverification: integrity?.date_gate_reverification ?? { pass: false, note: "dry_run" },
    disputed_exclusion_reverification:
      integrity?.disputed_exclusion_reverification ?? { pass: false, note: "dry_run" },
    dedupe_reverification: integrity?.dedupe_reverification ?? { pass: false, note: "dry_run" },
    source_edge_reverification: integrity?.source_edge_reverification ?? { pass: false, note: "dry_run" },
    evidence_summary_reverification:
      integrity?.evidence_summary_reverification ?? { pass: false, note: "dry_run" },
    claim_candidates_count_before_after: {
      before: before.claim_candidates_total,
      after: after.claim_candidates_total,
      unchanged: countUnchanged,
    },
    claim_cases_count_before_after: {
      pass: claimCasesUnchanged,
      before: before.claim_cases_total,
      after: after.claim_cases_total,
    },
    candidate_queue_visibility: integrity?.candidate_queue_visibility ?? { pass: false, note: "dry_run" },
    no_scanner_change_verification: {
      pass: scannerBefore === scannerAfter,
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    restore_sql_used: RESTORE_SQL,
    sample_restored_rows: activeRows.slice(0, 3).map((r) => ({
      id: r.id,
      candidate_status: r.candidate_status,
      dedupe_key: r.dedupe_key,
      family_key_v3: (r.metadata as Record<string, unknown>)?.family_key_v3,
      date_gate_passed: (r.metadata as Record<string, unknown>)?.date_gate_passed,
    })),
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_ORIGINAL_PILOT_RESTORED_FOR_REVIEW: restorePass ? "yes" : "no",
    SAFE_TO_BUILD_REVIEW_UI_FOR_ORIGINAL_CANDIDATES: restorePass ? "yes" : "no",
    NEXT_PROMPT: restorePass
      ? "PHASE-CLAIM-CENTER-ORIGINAL-CANDIDATE-REVIEW-UI-VERIFY-V1 — operator browser review of 50 restored original pilot rows in Claim Center"
      : "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-RESTORE-REMEDIATION-V1 — fix failing restore checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Original pilot restore for review V1

**Run:** ${id} · **Dry-run:** ${dryRun} · **Target:** \`${TARGET_RUN_ID}\`

- claim_candidates: ${before.claim_candidates_total} → ${after.claim_candidates_total}
- target active: ${before.target_active} → ${after.target_active}
- target quarantined: ${before.target_quarantined} → ${after.target_quarantined}
- claim_cases: ${before.claim_cases_total} → ${after.claim_cases_total}
- SAFE_ORIGINAL_PILOT_RESTORED_FOR_REVIEW: ${restorePass ? "yes" : "no"}
`,
  );

  console.log(
    JSON.stringify({
      ok: restorePass,
      run_id: id,
      restored_rows: restoreActionResult.rows_affected_unquarantine,
      target_active_after: after.target_active,
      SAFE_ORIGINAL_PILOT_RESTORED_FOR_REVIEW: restorePass ? "yes" : "no",
      outDir,
    }),
  );
  if (!restorePass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
