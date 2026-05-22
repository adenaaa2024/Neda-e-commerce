/**
 * V204 — claim_candidates missing amazon_removals source quarantine (staging).
 *
 *   npx tsx scripts/claim-missing-source-cleanup-v204-staging.ts --run-id=20260522T200000Z
 *   npx tsx scripts/claim-missing-source-cleanup-v204-staging.ts --run-id=20260522T200000Z --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/v204-claim-missing-source-cleanup";
const APPROVAL_REL = ".cursor/operator-approvals/claim-missing-source-cleanup-v204-approval.md";
const QUARANTINE_STATUS = "quarantined_missing_source";
const SOURCE_TABLE = "amazon_removals";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function approvalOk(): boolean {
  const p = path.join(process.cwd(), APPROVAL_REL);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return /APPROVED_TO_RUN_STAGING[\s\S]*?\|\s*`?true`?\s*\|/i.test(text);
}

type PreimageRow = {
  id: string;
  organization_id: string;
  source_row_id: string;
  claim_family: string;
  claim_reason: string | null;
  old_candidate_status: string | null;
  old_evidence_status: string | null;
  old_resolved_product_id: string | null;
};

const MISSING_SOURCE_WHERE = `
  c.source_table = '${SOURCE_TABLE}'
  AND NOT EXISTS (
    SELECT 1 FROM public.amazon_removals rm
    WHERE rm.id = c.source_row_id AND rm.organization_id = c.organization_id
  )
`;

const ACTIVE_MISSING_SOURCE_WHERE = `
  ${MISSING_SOURCE_WHERE}
  AND COALESCE(c.candidate_status, '') NOT IN ('${QUARANTINE_STATUS}', 'archived_missing_source')
`;

async function countMissingSource(client: pg.Client, activeOnly: boolean): Promise<number> {
  const where = activeOnly ? ACTIVE_MISSING_SOURCE_WHERE : MISSING_SOURCE_WHERE;
  const res = await client.query(
    `SELECT COUNT(*)::bigint AS c FROM public.claim_candidates c WHERE ${where}`,
  );
  return Number(res.rows[0]?.c ?? 0);
}

async function loadCohort(client: pg.Client): Promise<PreimageRow[]> {
  const res = await client.query(`
    SELECT
      c.id::text AS id,
      c.organization_id::text AS organization_id,
      c.source_row_id::text AS source_row_id,
      c.claim_family,
      c.claim_reason,
      c.candidate_status AS old_candidate_status,
      c.evidence_status AS old_evidence_status,
      c.resolved_product_id::text AS old_resolved_product_id
    FROM public.claim_candidates c
    WHERE ${ACTIVE_MISSING_SOURCE_WHERE}
    ORDER BY c.id
  `);
  return res.rows as PreimageRow[];
}

function writeRollbackSql(outDir: string, rows: PreimageRow[]): void {
  const lines = [
    "-- V204 rollback: restore claim_candidates quarantine fields",
    "BEGIN;",
  ];
  for (const r of rows) {
    const st = r.old_candidate_status === null ? "NULL" : `'${r.old_candidate_status.replace(/'/g, "''")}'`;
    lines.push(
      `UPDATE public.claim_candidates SET candidate_status = ${st}, updated_at = now() WHERE id = '${r.id}'::uuid;`,
    );
  }
  lines.push("COMMIT;");
  fs.writeFileSync(path.join(outDir, "rollback.sql"), lines.join("\n"), "utf8");
}

async function applyQuarantine(client: pg.Client, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  let applied = 0;
  const CHUNK = 500;
  await client.query("BEGIN");
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const res = await client.query(
        `UPDATE public.claim_candidates c
         SET candidate_status = $2, updated_at = now()
         WHERE c.id = ANY($1::uuid[])
           AND ${ACTIVE_MISSING_SOURCE_WHERE}`,
        [slice, QUARANTINE_STATUS],
      );
      applied += res.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return applied;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF}, got ${ref ?? "unset"})`);
  }

  if (execute && !approvalOk()) {
    throw new Error(`Execute blocked: missing or false ${APPROVAL_REL}`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const preActiveMissing = await countMissingSource(client, true);
  const preTotalMissing = await countMissingSource(client, false);
  const cohort = await loadCohort(client);

  if (cohort.length !== preActiveMissing) {
    await client.end();
    throw new Error(`Cohort size ${cohort.length} != active missing count ${preActiveMissing}`);
  }

  const pkAllowlist = cohort.map((r) => r.id);
  fs.writeFileSync(path.join(outDir, "pk-allowlist.json"), JSON.stringify(pkAllowlist, null, 2));
  fs.writeFileSync(
    path.join(outDir, "rollback-preimage-rows.json"),
    JSON.stringify(cohort, null, 2),
  );
  writeRollbackSql(outDir, cohort);

  const statusBefore = await client.query(`
    SELECT COALESCE(candidate_status, '(null)') AS st, COUNT(*)::bigint AS n
    FROM public.claim_candidates c WHERE ${MISSING_SOURCE_WHERE}
    GROUP BY 1 ORDER BY n DESC
  `);

  let applied = 0;
  if (execute) {
    applied = await applyQuarantine(client, pkAllowlist);
  }

  const postActiveMissing = execute ? await countMissingSource(client, true) : preActiveMissing;
  const postQuarantined = execute
    ? Number(
        (
          await client.query(
            `SELECT COUNT(*)::bigint AS c FROM public.claim_candidates c
             WHERE ${MISSING_SOURCE_WHERE} AND c.candidate_status = $1`,
            [QUARANTINE_STATUS],
          )
        ).rows[0]?.c ?? 0,
      )
    : 0;

  await client.end();

  const dryRun = {
    source_table: SOURCE_TABLE,
    quarantine_status: QUARANTINE_STATUS,
    pre_active_missing_source: preActiveMissing,
    pre_total_missing_source_including_quarantined: preTotalMissing,
    pk_allowlist_count: pkAllowlist.length,
    candidate_status_distribution_before: statusBefore.rows,
    execute,
    applied,
    post_active_missing_source: postActiveMissing,
    post_quarantined_missing_source: postQuarantined,
  };

  fs.writeFileSync(path.join(outDir, "dry-run-summary.json"), JSON.stringify(dryRun, null, 2));

  const pass = execute && postActiveMissing === 0 && applied === pkAllowlist.length;
  const status = !execute ? "DRY_RUN_OK" : pass ? "PASS" : "FAIL";

  const manifest = {
    prompt: "V204-CLAIM-MISSING-SOURCE-CLEANUP",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: execute ? "dry_run_and_execute" : "dry_run",
    approval_file: APPROVAL_REL,
    applied,
    pk_allowlist_count: pkAllowlist.length,
    active_missing_source_before: preActiveMissing,
    active_missing_source_after: postActiveMissing,
    quarantined_total: postQuarantined,
    blocker_b2_closed: pass,
    status,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-summary.md"),
    [
      "# V204 — claim missing-source quarantine",
      "",
      `- run_id: \`${runId}\``,
      `- staging: \`${STAGING_REF}\``,
      `- mode: ${execute ? "**execute**" : "dry-run"}`,
      "",
      "## Cohort",
      `- Source: \`${SOURCE_TABLE}\` with no operational row`,
      `- PK allowlist: **${pkAllowlist.length}**`,
      `- Action: \`candidate_status\` → \`${QUARANTINE_STATUS}\` (no DELETE)`,
      "",
      execute
        ? [
            "## Applied",
            `- Rows updated: **${applied}**`,
            `- Active missing-source after: **${postActiveMissing}** (target 0)`,
            `- Quarantined (lane total): **${postQuarantined}**`,
          ].join("\n")
        : "## Next\nRun with `--execute` after approval.",
      "",
      `Status: **${status}**`,
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
  if (execute && !pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
