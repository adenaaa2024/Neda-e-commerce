/**
 * EMERGENCY-RETURN-ITEMS-WAVE2-ROLLBACK-EXECUTE
 *   npx tsx scripts/emergency-return-items-wave2-rollback-execute.ts --run-id=<UTC>
 *   npx tsx scripts/emergency-return-items-wave2-rollback-execute.ts --run-id=<UTC> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const AUDIT_DIR = ".cursor/audit-reports/emergency-return-items-backfill-rollback-audit/20260521T233000Z";
const WAVE2_DIR = ".cursor/audit-reports/expected-linkage-return-items-backfill-scale-wave2/20260521T220500Z";
const APPROVAL_PATH = ".cursor/operator-approvals/emergency-return-items-backfill-rollback-approval.md";
const OUT_BASE = ".cursor/audit-reports/emergency-return-items-wave2-rollback-execute";
const EXPECTED_PRE_WAVE_RESOLVED = 57;
const EXPECTED_AFFECTED = 5283;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function parseRollbackIds(sql: string): string[] {
  const re = /WHERE id = '([0-9a-f-]{36})'::uuid/gi;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) ids.push(m[1]!);
  return ids;
}

function readApproval(): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return { ok: false, reasons: ["approval_file_missing"] };
  const text = fs.readFileSync(p, "utf8");
  if (!/APPROVED_EMERGENCY_RETURN_ITEMS_ROLLBACK\s*=\s*true/i.test(text)) {
    reasons.push("APPROVED_EMERGENCY_RETURN_ITEMS_ROLLBACK_not_true");
  }
  if (!/ROLLBACK_SCOPE\s*=\s*wave2_return_items_resolved_product_id_only/i.test(text)) {
    reasons.push("ROLLBACK_SCOPE_mismatch");
  }
  if (!new RegExp(`TARGET_SUPABASE_REF\\s*=\\s*${STAGING_REF}`, "i").test(text)) {
    reasons.push("TARGET_SUPABASE_REF_mismatch");
  }
  return { ok: reasons.length === 0, reasons };
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return r.rowCount === 1;
}

async function snapshotCounts(client: pg.Client, affectedIds: string[]): Promise<Record<string, unknown>> {
  const base = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map) AS product_identifier_map,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.return_items) AS return_items_total,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS return_items_active,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL) AS return_items_resolved
  `);

  const affected = await client.query(
    `
    SELECT
      COUNT(*)::int AS affected_total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS affected_resolved,
      COUNT(*) FILTER (WHERE identifier_resolution_status = 'resolved')::int AS affected_status_resolved,
      COUNT(*) FILTER (WHERE identifier_resolution_confidence = 1.0)::int AS affected_conf_one,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS affected_unresolved
    FROM public.return_items
    WHERE id = ANY($1::uuid[])
  `,
    [affectedIds],
  );

  const out: Record<string, unknown> = {
    ...base.rows[0],
    affected: affected.rows[0],
  };

  if (await tableExists(client, "claim_case_evidence")) {
    const ce = await client.query(
      `SELECT COUNT(*)::int AS claim_case_evidence_on_affected
       FROM public.claim_case_evidence WHERE return_item_id = ANY($1::uuid[])`,
      [affectedIds],
    );
    out.claim_case_evidence_on_affected = ce.rows[0]?.claim_case_evidence_on_affected ?? 0;
  } else {
    out.claim_case_evidence_on_affected = null;
    out.claim_tables_note = "claim_case_evidence table not present";
  }

  if (await tableExists(client, "claim_cases")) {
    const cc = await client.query(`SELECT COUNT(*)::int AS claim_cases_total FROM public.claim_cases`);
    out.claim_cases_total = cc.rows[0]?.claim_cases_total ?? 0;
  }

  return out;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const approval = readApproval();
  if (!approval.ok) {
    throw new Error(`Approval gate failed: ${approval.reasons.join(", ")}`);
  }

  const rollbackPath = path.join(process.cwd(), WAVE2_DIR, "rollback.sql");
  const rollbackSql = fs.readFileSync(rollbackPath, "utf8");
  const affectedIds = parseRollbackIds(rollbackSql);
  if (affectedIds.length !== EXPECTED_AFFECTED) {
    throw new Error(`Expected ${EXPECTED_AFFECTED} rollback IDs, got ${affectedIds.length}`);
  }

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '600s'");

  const beforeCounts = await snapshotCounts(client, affectedIds);
  fs.writeFileSync(path.join(outDir, "before-counts.json"), JSON.stringify(beforeCounts, null, 2));

  const preflight = await client.query(
    `
    SELECT
      COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
    FROM public.return_items WHERE id = ANY($1::uuid[])
  `,
    [affectedIds],
  );

  let statementsExecuted = 0;
  if (apply) {
    const statements = rollbackSql
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("UPDATE public.return_items"));

    await client.query("BEGIN");
    try {
      for (const stmt of statements) {
        const res = await client.query(stmt);
        if (res.rowCount !== 1) {
          throw new Error(`Rollback statement affected ${res.rowCount} rows (expected 1): ${stmt.slice(0, 120)}...`);
        }
        statementsExecuted += 1;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }

  const afterCounts = await snapshotCounts(client, affectedIds);
  fs.writeFileSync(path.join(outDir, "after-counts.json"), JSON.stringify(afterCounts, null, 2));

  await client.end();

  const beforeActive = Number(beforeCounts.return_items_active);
  const afterActive = Number(afterCounts.return_items_active);
  const beforeResolved = Number(beforeCounts.return_items_resolved);
  const afterResolved = Number(afterCounts.return_items_resolved);
  const beforeAffectedResolved = Number((beforeCounts.affected as { affected_resolved?: number })?.affected_resolved);
  const afterAffectedResolved = Number((afterCounts.affected as { affected_resolved?: number })?.affected_resolved);
  const afterAffectedUnresolved = Number((afterCounts.affected as { affected_unresolved?: number })?.affected_unresolved);

  const verification = {
    products_unchanged: beforeCounts.products === afterCounts.products,
    map_unchanged: beforeCounts.product_identifier_map === afterCounts.product_identifier_map,
    ep_unchanged: beforeCounts.expected_packages === afterCounts.expected_packages,
    return_items_total_unchanged: beforeCounts.return_items_total === afterCounts.return_items_total,
    active_unchanged: beforeActive === afterActive,
    active_is_5366: afterActive === 5366,
    resolved_restored_to_pre_wave:
      !apply || afterResolved === EXPECTED_PRE_WAVE_RESOLVED || afterResolved === beforeResolved - EXPECTED_AFFECTED,
    affected_all_unresolved: !apply || afterAffectedUnresolved === EXPECTED_AFFECTED,
    affected_resolved_zero: !apply || afterAffectedResolved === 0,
    preflight_had_wave2_values: beforeAffectedResolved === EXPECTED_AFFECTED,
    statements_executed: statementsExecuted,
  };

  const pass =
    apply &&
    verification.products_unchanged &&
    verification.map_unchanged &&
    verification.ep_unchanged &&
    verification.return_items_total_unchanged &&
    verification.active_unchanged &&
    verification.affected_all_unresolved &&
    verification.affected_resolved_zero &&
    afterResolved === EXPECTED_PRE_WAVE_RESOLVED;

  const report = `# EMERGENCY-RETURN-ITEMS-WAVE2-ROLLBACK-EXECUTE

**Run:** \`${OUT_BASE}/${runId}/\`  
**Mode:** ${apply ? "APPLY" : "DRY-RUN"}  
**Staging:** \`${STAGING_REF}\`  
**Audit:** \`${AUDIT_DIR}/\`  
**Rollback SQL:** \`${WAVE2_DIR}/rollback.sql\`

# APPROVAL_VALIDATION

- Approval file: \`${APPROVAL_PATH}\`
- \`APPROVED_EMERGENCY_RETURN_ITEMS_ROLLBACK=true\`: **PASS**
- \`TARGET_SUPABASE_REF=${STAGING_REF}\`: **PASS**
- \`ROLLBACK_SCOPE=wave2_return_items_resolved_product_id_only\`: **PASS**

# BEFORE_COUNTS

| Metric | Value |
|--------|------:|
| return_items active | ${beforeActive} |
| return_items resolved | ${beforeResolved} |
| return_items total | ${beforeCounts.return_items_total} |
| products | ${beforeCounts.products} |
| expected_packages | ${beforeCounts.expected_packages} |
| product_identifier_map | ${beforeCounts.product_identifier_map} |
| affected rows (5283 set) | ${(beforeCounts.affected as { affected_total?: number })?.affected_total} |
| affected with resolved_product_id | ${beforeAffectedResolved} |
| claim_case_evidence on affected | ${beforeCounts.claim_case_evidence_on_affected ?? "n/a"} |

# ROLLBACK_EXECUTED

- Mode: **${apply ? "YES" : "NO (dry-run)"}**
- Statements executed: **${statementsExecuted}** / ${EXPECTED_AFFECTED}
- Tables written: **return_items only** (resolved_product_id, identifier_resolution_status, identifier_resolution_confidence, updated_at)

# AFTER_COUNTS

| Metric | Before | After |
|--------|-------:|------:|
| return_items active | ${beforeActive} | ${afterActive} |
| return_items resolved | ${beforeResolved} | ${afterResolved} |
| affected resolved | ${beforeAffectedResolved} | ${afterAffectedResolved} |
| affected unresolved | — | ${afterAffectedUnresolved} |
| products | ${beforeCounts.products} | ${afterCounts.products} |
| expected_packages | ${beforeCounts.expected_packages} | ${afterCounts.expected_packages} |
| product_identifier_map | ${beforeCounts.product_identifier_map} | ${afterCounts.product_identifier_map} |

# TABLES_TOUCHED

| Table | Modified |
|-------|----------|
| return_items | ${apply ? "YES — revert 5283 linkage fields only" : "NO"} |
| expected_packages | NO |
| products | NO |
| product_identifier_map | NO |

# CLAIM_RISK_AFTER_ROLLBACK

${apply && pass
    ? "Wave2 denormalization reverted. **Do not** build claim lines or auto-promote from the 5283 bulk expected-linked return_items until product resolution is rebuilt from proven physical scanner receive flow only."
    : apply
      ? "Rollback verification incomplete — hold all claim/return linkage work."
      : "Dry-run only — no DB changes."}

Affected rows remain in \`return_items\` but **must not** be treated as physically scanned inventory for claims until separately audited.

# NEXT_ARCHITECTURE_AUDIT_PROMPT

\`\`\`text
RETURN-ITEMS-BULK-INSERT-PROVENANCE-AUDIT

Goal: Identify who/what inserted 5283 return_items on 2026-05-30 (02:00–04:00 UTC) with expected_item_id only and no package/pallet/slip/operator.
Determine whether those rows should remain, be deleted, or be moved to expected allocation structures.
Forbidden: claim creation, auto-promote, further EP→RI denormalization.
\`\`\`

## Verification: **${pass ? "PASS" : apply ? "FAIL" : "PENDING (--apply)"}**
`;

  fs.writeFileSync(path.join(outDir, "apply-result.md"), report);
  fs.writeFileSync(path.join(outDir, "verification.json"), JSON.stringify(verification, null, 2));

  const manifest = {
    prompt: "EMERGENCY-RETURN-ITEMS-WAVE2-ROLLBACK-EXECUTE",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: apply ? "apply" : "dry-run",
    status: pass ? "PASS" : apply ? "FAIL" : "DRY-RUN",
    statements_executed: statementsExecuted,
    before_counts: beforeCounts,
    after_counts: afterCounts,
    verification,
    expected_pre_wave_resolved: EXPECTED_PRE_WAVE_RESOLVED,
    actual_after_resolved: afterResolved,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));

  if (apply && !pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
