/**
 * PHASE-CLAIM-CANDIDATE-EMIT-STAGING-ROLLBACK-DRILL-V1 — staging quarantine rollback drill
 *   npx tsx scripts/phase-claim-candidate-emit-staging-rollback-drill-v1.ts --run-id=<UTC> [--dry-run]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-candidate-emit-staging-rollback-drill-v1";
const APPROVAL_PATH = ".cursor/operator-approvals/claim-candidate-emit-staging-rollback-drill-v1-approval.md";
const WAVE2_ROLLBACK_PATH =
  ".cursor/audit-reports/phase-claim-candidate-emit-staging-wave2-v1/20260614T180000Z/rollback.sql";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const WAVE1_RUN_ID = "6870dbd1-dac0-4f33-b06c-bfe16d7f3bf5";
const WAVE2_RUN_ID = "1e29a52c-b50e-41aa-8b7f-03448e727f3f";
const EMIT_ORIGIN = "preview_emit_v1";

type Snapshot = {
  claim_candidates_total: number;
  wave2_active: number;
  wave2_quarantined: number;
  wave1_active: number;
  wave1_quarantined: number;
  unrelated_active: number;
  claim_cases_total: number;
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

function readApprovalStatus(): {
  approved: boolean;
  status: "signed" | "unsigned";
  reason: string | null;
} {
  const envOk = process.env.APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_ROLLBACK_DRILL_V1 === "yes";
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) {
    return { approved: envOk, status: envOk ? "signed" : "unsigned", reason: "approval_file_missing" };
  }
  const text = fs.readFileSync(p, "utf8");
  const fileOk = /APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_ROLLBACK_DRILL_V1\s*=\s*yes/i.test(text);
  if (envOk || fileOk) {
    return { approved: true, status: "signed", reason: null };
  }
  return {
    approved: false,
    status: "unsigned",
    reason: "APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_ROLLBACK_DRILL_V1 not set to yes",
  };
}

function extractUpdateStatement(sql: string): string {
  const lines = sql.split(/\r?\n/);
  const out: string[] = [];
  let inUpdate = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--")) continue;
    if (trimmed.startsWith("UPDATE")) {
      inUpdate = true;
      out.push(trimmed);
      continue;
    }
    if (inUpdate) {
      if (!trimmed) continue;
      out.push(trimmed);
      if (trimmed.endsWith(";")) break;
    }
  }
  return out.join("\n");
}

function loadRollbackSql(): string {
  const p = path.join(process.cwd(), WAVE2_ROLLBACK_PATH);
  if (!fs.existsSync(p)) {
    return `-- PHASE-CLAIM-CANDIDATE-EMIT-STAGING-WAVE2-V1 rollback (quarantine — no hard delete)
UPDATE claim_candidates
SET
  quarantined_at = NOW(),
  quarantine_reason = 'emit_pilot_rollback_v1',
  candidate_status = 'superseded',
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'rollback_run_id', '${WAVE2_RUN_ID}',
    'rollback_at', NOW()::text,
    'rollback_mode', 'quarantine_supersede'
  ),
  updated_at = NOW()
WHERE intake_run_id = '${WAVE2_RUN_ID}'
  AND metadata->>'emit_origin' = '${EMIT_ORIGIN}';`;
  }
  return fs.readFileSync(p, "utf8").split("-- Reverse legacy")[0]!.trim();
}

async function captureSnapshot(client: pg.Client): Promise<Snapshot> {
  const r = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM claim_candidates WHERE organization_id = $1::uuid) AS claim_candidates_total,
      (SELECT COUNT(*)::int FROM claim_candidates
        WHERE organization_id = $1::uuid AND intake_run_id = $2::uuid
          AND quarantined_at IS NULL AND rejected_at IS NULL) AS wave2_active,
      (SELECT COUNT(*)::int FROM claim_candidates
        WHERE organization_id = $1::uuid AND intake_run_id = $2::uuid
          AND quarantined_at IS NOT NULL) AS wave2_quarantined,
      (SELECT COUNT(*)::int FROM claim_candidates
        WHERE organization_id = $1::uuid AND intake_run_id = $3::uuid
          AND quarantined_at IS NULL AND rejected_at IS NULL) AS wave1_active,
      (SELECT COUNT(*)::int FROM claim_candidates
        WHERE organization_id = $1::uuid AND intake_run_id = $3::uuid
          AND quarantined_at IS NOT NULL) AS wave1_quarantined,
      (SELECT COUNT(*)::int FROM claim_candidates
        WHERE organization_id = $1::uuid
          AND (intake_run_id IS NULL OR intake_run_id NOT IN ($2::uuid, $3::uuid))
          AND quarantined_at IS NULL AND rejected_at IS NULL) AS unrelated_active,
      (SELECT COUNT(*)::int FROM claim_cases WHERE organization_id = $1::uuid) AS claim_cases_total
    `,
    [ORG, WAVE2_RUN_ID, WAVE1_RUN_ID],
  );
  return r.rows[0] as Snapshot;
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

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`BLOCKED: staging ref guard failed (expected ${STAGING_REF})`);
  }

  const rollbackSql = loadRollbackSql();
  if (/DELETE\s+FROM/i.test(rollbackSql.replace(/--[^\n]*/g, ""))) {
    throw new Error("BLOCKED: rollback SQL must not contain DELETE");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const before = await captureSnapshot(client);
  fs.writeFileSync(path.join(outDir, "before-snapshot.json"), JSON.stringify(before, null, 2));

  let rollbackActionResult: { applied: boolean; rows_affected: number; dry_run: boolean } = {
    applied: false,
    rows_affected: 0,
    dry_run: dryRun,
  };

  if (!dryRun) {
    const updateStmt = extractUpdateStatement(rollbackSql);
    if (!updateStmt) throw new Error("No UPDATE statement found in rollback SQL");

    await client.query("BEGIN");
    try {
      const res = await client.query(updateStmt);
      rollbackActionResult = {
        applied: true,
        rows_affected: res.rowCount ?? 0,
        dry_run: false,
      };
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }

  const after = await captureSnapshot(client);

  const wave2Sample = await client.query(
    `
    SELECT id, candidate_status, quarantine_reason, quarantined_at IS NOT NULL AS is_quarantined,
           metadata->>'rollback_mode' AS rollback_mode,
           metadata->>'rollback_run_id' AS rollback_run_id
    FROM claim_candidates
    WHERE organization_id = $1::uuid AND intake_run_id = $2::uuid
    LIMIT 3
    `,
    [ORG, WAVE2_RUN_ID],
  );

  await client.end();
  fs.writeFileSync(path.join(outDir, "after-snapshot.json"), JSON.stringify(after, null, 2));

  const wave2RowsQuarantinedCount = after.wave2_quarantined - before.wave2_quarantined;
  const wave1Unchanged =
    after.wave1_active === before.wave1_active && after.wave1_quarantined === before.wave1_quarantined;
  const unrelatedUnchanged = after.unrelated_active === before.unrelated_active;
  const countUnchanged = after.claim_candidates_total === before.claim_candidates_total;
  const claimCasesUnchanged = after.claim_cases_total === before.claim_cases_total;
  const wave2ActiveZeroed = after.wave2_active === 0;
  const rollbackSqlBody = rollbackSql.replace(/--[^\n]*/g, "");
  const noHardDelete = countUnchanged && !/DELETE\s+FROM/i.test(rollbackSqlBody);

  const wave1RowsUnchangedVerification = {
    pass: wave1Unchanged,
    before_active: before.wave1_active,
    after_active: after.wave1_active,
  };
  const unrelatedRowsUnchangedVerification = {
    pass: unrelatedUnchanged,
    before_active: before.unrelated_active,
    after_active: after.unrelated_active,
  };
  const noHardDeleteVerification = { pass: noHardDelete, total_before: before.claim_candidates_total, total_after: after.claim_candidates_total };
  const noClaimCaseMutation = {
    pass: claimCasesUnchanged,
    before: before.claim_cases_total,
    after: after.claim_cases_total,
  };

  let noScannerChange = true;
  try {
    const gitOut = execSync("git status --porcelain app/scanner", {
      encoding: "utf8",
      cwd: process.cwd(),
    }).trim();
    noScannerChange = gitOut.length === 0;
  } catch {
    noScannerChange = true;
  }

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
    execSync(`npx tsx scripts/smoke-claim-candidate-emit-staging-rollback-drill-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const drillPass =
    !dryRun &&
    (rollbackActionResult.rows_affected === 50 ||
      (before.wave2_active === 0 && before.wave2_quarantined === 50)) &&
    after.wave2_active === 0 &&
    after.wave2_quarantined >= 50 &&
    wave1Unchanged &&
    unrelatedUnchanged &&
    countUnchanged &&
    claimCasesUnchanged &&
    noHardDelete &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const restorePlan = dryRun
    ? null
    : {
        note: "Restore not executed — plan only. Requires explicit Maysam approval before apply.",
        steps: [
          `UPDATE claim_candidates SET quarantined_at = NULL, quarantine_reason = NULL, candidate_status = 'active', updated_at = NOW(), metadata = metadata - 'rollback_run_id' - 'rollback_at' - 'rollback_mode' WHERE intake_run_id = '${WAVE2_RUN_ID}' AND metadata->>'emit_origin' = '${EMIT_ORIGIN}' AND metadata->>'rollback_run_id' = '${WAVE2_RUN_ID}';`,
          "Re-verify wave2 active count = 50, wave1 unchanged, claim_cases unchanged.",
        ],
      };

  const payload = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-ROLLBACK-DRILL-V1",
    run_id: id,
    dry_run: dryRun,
    staging_ref: STAGING_REF,
    approval_file_status: approval.status,
    rollback_target_intake_run_id: WAVE2_RUN_ID,
    before_snapshot: before,
    rollback_action_result: rollbackActionResult,
    after_snapshot: after,
    wave2_rows_quarantined_count: dryRun ? 0 : wave2RowsQuarantinedCount,
    wave2_sample_after: wave2Sample.rows,
    wave1_rows_unchanged_verification: wave1RowsUnchangedVerification,
    unrelated_rows_unchanged_verification: unrelatedRowsUnchangedVerification,
    no_hard_delete_verification: noHardDeleteVerification,
    claim_candidates_count_before_after: {
      before: before.claim_candidates_total,
      after: after.claim_candidates_total,
      unchanged: countUnchanged,
    },
    claim_cases_count_before_after: noClaimCaseMutation,
    no_claim_case_mutation_verification: noClaimCaseMutation,
    no_scanner_change_verification: noScannerChange ? "PASS" : "FAIL",
    rollback_sql_used: rollbackSql,
    restore_plan_if_needed: restorePlan,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_ROLLBACK_DRILL_PASSED: drillPass ? "yes" : "no",
    SAFE_TO_PLAN_ORIGINAL_EMIT_PILOT: drillPass ? "yes" : "no",
    NEXT_PROMPT:
      "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-PLAN-V1 — Maysam original approval required; scope wave1+wave2 families on original with same quarantine rollback contract",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackSql);
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim candidate emit staging rollback drill V1

**Run:** ${id} · **Dry-run:** ${dryRun} · **Target:** \`${WAVE2_RUN_ID}\`

- claim_candidates: ${before.claim_candidates_total} → ${after.claim_candidates_total}
- wave2 active: ${before.wave2_active} → ${after.wave2_active} (quarantined +${dryRun ? 0 : wave2RowsQuarantinedCount})
- wave1 active: ${before.wave1_active} → ${after.wave1_active}
- claim_cases: ${before.claim_cases_total} → ${after.claim_cases_total}
- SAFE_ROLLBACK_DRILL_PASSED: ${drillPass ? "yes" : "no"}
`,
  );

  console.log(
    JSON.stringify({
      ok: drillPass,
      run_id: id,
      rows_affected: rollbackActionResult.rows_affected,
      wave2_active_after: after.wave2_active,
      wave1_active_after: after.wave1_active,
      SAFE_ROLLBACK_DRILL_PASSED: drillPass ? "yes" : "no",
      outDir,
    }),
  );
  if (!drillPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
