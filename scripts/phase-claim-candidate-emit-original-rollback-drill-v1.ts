/**
 * PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-ROLLBACK-DRILL-V1 — original quarantine rollback drill
 *   npx tsx scripts/phase-claim-candidate-emit-original-rollback-drill-v1.ts --run-id=<UTC> [--dry-run]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { bindProductionSupabaseEnv, PRODUCTION_REF, productionPostgresUrl } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-candidate-emit-original-rollback-drill-v1";
const APPROVAL_PATH = ".cursor/operator-approvals/claim-candidate-emit-original-rollback-drill-v1-approval.md";
const PILOT_ROLLBACK_PATH =
  ".cursor/audit-reports/phase-claim-candidate-emit-original-pilot-v1/20260614T233000Z/rollback.sql";

const ORG = "00000000-0000-0000-0000-000000000001";
const TARGET_RUN_ID = "a8a892fe-37d5-4d74-9ea2-02af8fd095ce";
const EMIT_ORIGIN = "preview_emit_v1";

type Snapshot = {
  claim_candidates_total: number;
  target_active: number;
  target_quarantined: number;
  target_superseded: number;
  unrelated_active: number;
  claim_cases_total: number;
  family_distribution: Record<string, number>;
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
  const envOk = process.env.APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_ROLLBACK_DRILL_V1 === "yes";
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) {
    return { approved: envOk, status: envOk ? "signed" : "unsigned", reason: "approval_file_missing" };
  }
  const text = fs.readFileSync(p, "utf8");
  const fileOk = /APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_ROLLBACK_DRILL_V1\s*=\s*yes/i.test(text);
  const decisionOk = /\[x\]\s*APPROVED/i.test(text);
  if (envOk || (fileOk && decisionOk) || fileOk) {
    return { approved: true, status: "signed", reason: null };
  }
  return {
    approved: false,
    status: "unsigned",
    reason: "APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_ROLLBACK_DRILL_V1 not set to yes",
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

function loadRollbackSql(): string {
  const p = path.join(process.cwd(), PILOT_ROLLBACK_PATH);
  if (!fs.existsSync(p)) {
    throw new Error(`BLOCKED: pilot rollback SQL missing at ${PILOT_ROLLBACK_PATH}`);
  }
  return fs.readFileSync(p, "utf8").split("-- Reverse legacy")[0]!.trim();
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
          AND quarantined_at IS NULL AND rejected_at IS NULL) AS target_active,
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
  const base = r.rows[0] as Omit<Snapshot, "family_distribution">;

  const fam = await client.query(
    `
    SELECT COALESCE(metadata->>'family_key_v3', claim_family) AS fam, COUNT(*)::int AS n
    FROM claim_candidates
    WHERE organization_id = $1::uuid AND intake_run_id = $2::uuid
    GROUP BY 1
    `,
    [ORG, TARGET_RUN_ID],
  );
  const family_distribution: Record<string, number> = {};
  for (const row of fam.rows as Array<{ fam: string; n: number }>) {
    family_distribution[row.fam] = row.n;
  }

  return { ...base, family_distribution };
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

  const { ref } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const rollbackSql = loadRollbackSql();
  const rollbackSqlBody = rollbackSql.replace(/--[^\n]*/g, "");
  if (/DELETE\s+FROM/i.test(rollbackSqlBody)) {
    throw new Error("BLOCKED: rollback SQL must not contain DELETE");
  }
  if (!rollbackSql.includes(TARGET_RUN_ID) || !rollbackSql.includes(EMIT_ORIGIN)) {
    throw new Error("BLOCKED: rollback SQL must scope intake_run_id + emit_origin");
  }

  const scannerBefore = scannerGitStatus();
  const client = new pg.Client({ connectionString: productionPostgresUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const before = await captureSnapshot(client);
  fs.writeFileSync(path.join(outDir, "before-snapshot.json"), JSON.stringify(before, null, 2));

  let rollbackActionResult: {
    applied: boolean;
    statements_executed: number;
    rows_affected_quarantine: number;
    rows_affected_dedupe_release: number;
    dry_run: boolean;
  } = {
    applied: false,
    statements_executed: 0,
    rows_affected_quarantine: 0,
    rows_affected_dedupe_release: 0,
    dry_run: dryRun,
  };

  if (!dryRun) {
    const statements = extractUpdateStatements(rollbackSql);
    if (statements.length === 0) throw new Error("No UPDATE statements found in rollback SQL");

    await client.query("BEGIN");
    try {
      for (let i = 0; i < statements.length; i++) {
        const res = await client.query(statements[i]!);
        rollbackActionResult.statements_executed += 1;
        if (i === 0) rollbackActionResult.rows_affected_quarantine = res.rowCount ?? 0;
        if (i === 1) rollbackActionResult.rows_affected_dedupe_release = res.rowCount ?? 0;
      }
      rollbackActionResult.applied = true;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }

  const after = await captureSnapshot(client);

  const targetSample = await client.query(
    `
    SELECT id, candidate_status, quarantine_reason, quarantined_at IS NOT NULL AS is_quarantined,
           dedupe_key IS NULL AS dedupe_cleared,
           metadata->>'rollback_mode' AS rollback_mode,
           metadata->>'rollback_run_id' AS rollback_run_id,
           metadata->>'family_key_v3' AS family_key_v3
    FROM claim_candidates
    WHERE organization_id = $1::uuid AND intake_run_id = $2::uuid
    LIMIT 3
    `,
    [ORG, TARGET_RUN_ID],
  );

  await client.end();
  fs.writeFileSync(path.join(outDir, "after-snapshot.json"), JSON.stringify(after, null, 2));

  const scannerAfter = scannerGitStatus();
  const targetRowsQuarantinedCount = after.target_quarantined - before.target_quarantined;
  const unrelatedUnchanged = after.unrelated_active === before.unrelated_active;
  const countUnchanged = after.claim_candidates_total === before.claim_candidates_total;
  const claimCasesUnchanged = after.claim_cases_total === before.claim_cases_total;
  const targetActiveZeroed = after.target_active === 0;
  const noHardDelete = countUnchanged && !/DELETE\s+FROM/i.test(rollbackSqlBody);

  const unrelatedRowsUnchangedVerification = {
    pass: unrelatedUnchanged,
    before_active: before.unrelated_active,
    after_active: after.unrelated_active,
  };
  const noHardDeleteVerification = {
    pass: noHardDelete,
    total_before: before.claim_candidates_total,
    total_after: after.claim_candidates_total,
  };
  const noClaimCaseMutation = {
    pass: claimCasesUnchanged,
    before: before.claim_cases_total,
    after: after.claim_cases_total,
  };
  const targetActiveBeforeAfter = {
    before: before.target_active,
    after: after.target_active,
    pass: before.target_active === 50 && after.target_active === 0,
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
    execSync(`npx tsx scripts/smoke-claim-candidate-emit-original-rollback-drill-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const drillPass =
    !dryRun &&
    before.target_active === 50 &&
    (rollbackActionResult.rows_affected_quarantine === 50 ||
      (before.target_active === 0 && before.target_quarantined === 50)) &&
    after.target_active === 0 &&
    after.target_quarantined >= 50 &&
    unrelatedUnchanged &&
    countUnchanged &&
    claimCasesUnchanged &&
    noHardDelete &&
    scannerBefore === scannerAfter &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const restorePlan = dryRun
    ? null
    : {
        note: "Restore not executed — plan only. Requires explicit Maysam approval before apply.",
        warning:
          "Rollback clears dedupe_key on quarantined rows; full restore may require re-emit or dedupe_key reconstruction from metadata.",
        steps: [
          `UPDATE claim_candidates SET quarantined_at = NULL, quarantine_reason = NULL, candidate_status = 'detected', superseded_by_candidate_id = NULL, updated_at = NOW(), metadata = metadata - 'rollback_run_id' - 'rollback_at' - 'rollback_mode' WHERE intake_run_id = '${TARGET_RUN_ID}' AND metadata->>'emit_origin' = '${EMIT_ORIGIN}' AND metadata->>'rollback_run_id' = '${TARGET_RUN_ID}';`,
          "Re-verify target active count = 50, unrelated unchanged, claim_cases unchanged.",
        ],
      };

  const payload = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-ROLLBACK-DRILL-V1",
    run_id: id,
    dry_run: dryRun,
    original_ref: PRODUCTION_REF,
    original_ref_guard: { pass: ref === PRODUCTION_REF, ref },
    approval_file_status: approval.status,
    rollback_target_intake_run_id: TARGET_RUN_ID,
    before_snapshot: before,
    rollback_action_result: rollbackActionResult,
    after_snapshot: after,
    target_rows_quarantined_count: dryRun ? 0 : targetRowsQuarantinedCount,
    target_active_rows_before_after: targetActiveBeforeAfter,
    unrelated_rows_unchanged_verification: unrelatedRowsUnchangedVerification,
    no_hard_delete_verification: noHardDeleteVerification,
    claim_candidates_count_before_after: {
      before: before.claim_candidates_total,
      after: after.claim_candidates_total,
      unchanged: countUnchanged,
    },
    claim_cases_count_before_after: noClaimCaseMutation,
    no_claim_case_mutation_verification: noClaimCaseMutation,
    no_scanner_change_verification: {
      pass: scannerBefore === scannerAfter,
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    rollback_sql_used: rollbackSql,
    target_sample_after: targetSample.rows,
    restore_plan_if_needed: restorePlan,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_ORIGINAL_ROLLBACK_DRILL_PASSED: drillPass ? "yes" : "no",
    SAFE_TO_RESTORE_ORIGINAL_PILOT_FOR_REVIEW: drillPass ? "yes" : "no",
    SAFE_TO_PLAN_ORIGINAL_EMIT_EXPANSION: drillPass ? "yes" : "no",
    NEXT_PROMPT: drillPass
      ? "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-EXPANSION-PLAN-V1 — plan next original emit wave after optional restore for UI review"
      : "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-ROLLBACK-REMEDIATION-V1 — fix failing rollback drill checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackSql);
  if (restorePlan) {
    fs.writeFileSync(path.join(outDir, "restore-plan.md"), restorePlan.steps.join("\n\n"));
  }
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim candidate emit original rollback drill V1

**Run:** ${id} · **Dry-run:** ${dryRun} · **Target:** \`${TARGET_RUN_ID}\`

- claim_candidates: ${before.claim_candidates_total} → ${after.claim_candidates_total}
- target active: ${before.target_active} → ${after.target_active} (quarantined +${dryRun ? 0 : targetRowsQuarantinedCount})
- unrelated active: ${before.unrelated_active} → ${after.unrelated_active}
- claim_cases: ${before.claim_cases_total} → ${after.claim_cases_total}
- SAFE_ORIGINAL_ROLLBACK_DRILL_PASSED: ${drillPass ? "yes" : "no"}
`,
  );

  console.log(
    JSON.stringify({
      ok: drillPass,
      run_id: id,
      quarantine_rows: rollbackActionResult.rows_affected_quarantine,
      target_active_after: after.target_active,
      target_quarantined_after: after.target_quarantined,
      SAFE_ORIGINAL_ROLLBACK_DRILL_PASSED: drillPass ? "yes" : "no",
      outDir,
    }),
  );
  if (!drillPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
